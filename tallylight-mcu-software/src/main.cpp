#include <Arduino.h>
#include <optional>
#include <limits>

#include <WiFi.h>
#include <WiFiManager.h>
#include <ESPmDNS.h>
#include <FastLED.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>
#include <ArduinoNvs.h>
#include <NTPClient.h>
#include <WiFiUdp.h>
#include <HTTPUpdate.h>
#include <NetworkClient.h>

#ifndef ESP32
#error This code is intended to run on the ESP32 platform! Please check your Tools->Board menu.
#endif

// Base Hostname
constexpr const char baseHostname[] = "Tallylight-";

// Secrets
#ifndef OTA_PASSWORD
#define OTA_PASSWORD "tallylight" // default, should be overridden in build flags
#warning "OTA_PASSWORD not defined, using default 'tallylight'"
#endif
#ifndef AP_PASSWORD
#define AP_PASSWORD "tallylight" // default, should be overridden in build flags
#warning "AP_PASSWORD not defined, using default 'tallylight'"
#endif
#ifndef API_KEY
#define API_KEY "tallylight" // default, should be overridden in build flags
#warning "API_KEY not defined, using default 'tallylight'"
#endif

// LEDs
constexpr uint8_t ledstripPin = 5;
constexpr uint8_t ledCount = 6;
constexpr uint8_t builtinLed = 2;    // On-board LED pin
constexpr uint8_t builtinButton = 0; // On-board button pin

// WiFi-Manager
WiFiManager wm;

enum TallyState : uint8_t
{
    TALLY_OFF = 0,
    TALLY_STANDBY,
    TALLY_PROGRAM,
    TALLY_PREVIEW,
    TALLY_ERROR
    // update populateAllStates if new state is added
} tallyState;

String toString(TallyState state)
{
    switch (state)
    {
    case TALLY_OFF:
        return "OFF";
    case TALLY_STANDBY:
        return "STANDBY";
    case TALLY_PROGRAM:
        return "PROGRAM";
    case TALLY_PREVIEW:
        return "PREVIEW";
    case TALLY_ERROR:
        return "ERROR";
    default:
        return "UNKNOWN";
    }
}

std::optional<TallyState> fromString(const String &stateStr)
{
    if (stateStr == "OFF")
        return TALLY_OFF;
    else if (stateStr == "STANDBY")
        return TALLY_STANDBY;
    else if (stateStr == "PROGRAM")
        return TALLY_PROGRAM;
    else if (stateStr == "PREVIEW")
        return TALLY_PREVIEW;
    else if (stateStr == "ERROR")
        return TALLY_ERROR;
    else
        return std::nullopt;
}

void populateAllStates(JsonObject &obj)
{
    const auto arr = obj["states"].to<JsonArray>();
    for (uint8_t i = 0; i <= 4; i++)
    {
        TallyState state = static_cast<TallyState>(i);
        JsonObject stateObj = arr.add<JsonObject>();
        stateObj["id"] = i;
        stateObj["name"] = toString(state);
    }
}

// Setup FastLED
CRGB leds[ledCount];

// Webserver on port 81
static AsyncWebServer server(81);

// Time client
WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP, "pool.ntp.org", 0);

// Function to generate a unique hostname by appending the last 3 bytes of the MAC address
String generateHostname()
{
    uint8_t mac[6];
    WiFi.macAddress(mac);
    char uniquePart[7]; // 6 characters + null terminator
    snprintf(uniquePart, sizeof(uniquePart), "%02X%02X%02X", mac[3], mac[4], mac[5]);
    return String(baseHostname) + String(uniquePart);
}

// config
constexpr uint8_t configVersion = 1;

struct Config
{
    uint8_t brightness = std::numeric_limits<uint8_t>::max() / 2;
} config;

void saveConfig()
{
    NVS.setInt("configVersion", configVersion);
    NVS.setBlob("config", (uint8_t *)&config, sizeof(config));
    NVS.commit();
    Serial.println("Config saved");
}

void loadConfig()
{
    const auto version = NVS.getInt("configVersion", 0);
    if (version != configVersion)
    {
        Serial.println("No valid config found, using defaults");
        saveConfig();
        return;
    }

    // read config as blob
    bool success = NVS.getBlob("config", (uint8_t *)&config, sizeof(config));
    if (!success)
    {
        Serial.println("Failed to read config, using defaults");
        config = Config();
        saveConfig();
    }
    else
    {
        Serial.println("Config loaded");
    }
}

uint64_t lastPing = 1;

uint64_t identifyStart = 0;

uint64_t lastOtaTime = 0;

bool otaInProgress = false;

void setup()
{
    tallyState = TALLY_OFF;

    pinMode(builtinLed, OUTPUT);
    digitalWrite(builtinLed, HIGH); // Turn on during boot

    NVS.begin("tallylight");

    loadConfig();

    // Initialize FastLED
    FastLED.addLeds<WS2812B, ledstripPin, GRB>(leds, ledCount);
    FastLED.setBrightness(config.brightness);
    FastLED.clear();

    fill_rainbow(leds, ledCount, 0, 255 / ledCount);
    FastLED.show();

    Serial.begin(115200);
    delay(1000); // Give some time for the Serial Monitor to initialize

    WiFi.STA.begin(false); // Only initialize so we can get the MAC address

    // Generate and set the unique hostname
    String hostname = generateHostname();
    if (WiFi.setHostname(hostname.c_str()))
    {
        Serial.print("Hostname set to: ");
        Serial.println(hostname);
    }
    else
    {
        Serial.println("Failed to set hostname");
    }

    // Start WiFi in station mode
    WiFi.mode(WIFI_AP_STA);

    wm.setDebugOutput(true);
    wm.setConfigPortalBlocking(false); // Non-blocking, so we can do other stuff in loop
    wm.setCaptivePortalEnable(true);
    wm.setAPClientCheck(true);
    wm.setWebPortalClientCheck(true);
    wm.setWiFiAutoReconnect(true);
    wm.setCleanConnect(true);
    wm.setShowInfoUpdate(false);

    bool res = wm.autoConnect(hostname.c_str(), AP_PASSWORD);

    if (!res)
    {
        Serial.println("Failed to connect and hit timeout");
    }
    else
    {
        Serial.println("Connected to WiFi!");
        Serial.print("IP Address: ");
        Serial.println(WiFi.localIP());
    }

    // start mDNS
    if (MDNS.begin(hostname.c_str()))
    {
        Serial.println("mDNS responder started");
    }
    else
    {
        Serial.println("Error starting mDNS");
    }

    MDNS.setInstanceName(hostname.c_str());
    MDNS.addService("http", "tcp", 81);
    MDNS.addService("tallylight", "tcp", 81);

    server.on("/", HTTP_GET, [&hostname](AsyncWebServerRequest *request)
              { 
                // create json buffer
                JsonDocument doc;

                JsonObject root = doc.to<JsonObject>();
                root["hostname"] = WiFi.getHostname();
                root["ip"] = WiFi.localIP().toString();
                root["tallyState"] = toString(tallyState);
                root["gitHash"] = GIT_HASH;
                root["gitDirty"] = GIT_DIRTY;
                root["brightness"] = config.brightness;
                root["millis"] = millis();
                root["rssi"] = WiFi.RSSI();
                root["utcEpoch"] = timeClient.getEpochTime();

                populateAllStates(root);

                String response;
                if (serializeJson(doc, response) == 0)
                {
                    Serial.println(F("Failed to serialize JSON"));
                    request->send(500, "application/json", "{\"error\":\"Failed to serialize JSON\"}");
                    return;
                }
                request->send(200, "application/json", response); });

    server.on("/set", HTTP_GET, [](AsyncWebServerRequest *request)
              {
                  bool noAction = true;

                  // validate api key
                  if (!request->hasParam("apiKey") || request->getParam("apiKey")->value() != API_KEY)
                  {
                      request->send(403, "application/json", "{\"error\":\"Invalid API key\", \"success\": false}");
                      return;
                  }

                  JsonDocument responseDoc;
                  JsonObject responseObj = responseDoc.to<JsonObject>();

#define SEND_ERROR(msg)                                                                                            \
    {                                                                                                              \
        request->send(400, "application/json", String("{\"error\":\"") + msg + String("\", \"success\": false}")); \
        return;                                                                                                    \
    }

                  lastPing = millis();

                  if (request->hasParam("state"))
                  {
                      noAction = false;
                      String stateParam = request->getParam("state")->value();

                      auto stateValue = fromString(stateParam);

                      if (stateValue)
                      {
                          tallyState = static_cast<TallyState>(stateValue.value());
                      }
                      else
                      {
                          SEND_ERROR("Invalid state value");
                      }
                  }

                  if (request->hasParam("brightness"))
                  {
                      noAction = false;
                      String brightnessParam = request->getParam("brightness")->value();
                      int brightness = brightnessParam.toInt();
                      if (brightness >= 0 && brightness <= 255)
                      {
                          const uint8_t newBrightness = static_cast<uint8_t>(brightness);
                          if (newBrightness != config.brightness)
                          {
                              config.brightness = static_cast<uint8_t>(brightness);
                              saveConfig();
                          }
                      }
                      else
                      {
                          SEND_ERROR("Invalid brightness value");
                      }
                  }

                  if (noAction)
                  {
                      SEND_ERROR("No parameters given");
                  }

                  responseObj["success"] = true;
                  responseObj["tallyState"] = toString(tallyState);
                  responseObj["brightness"] = config.brightness;
                  request->send(200, "application/json", responseDoc.as<String>());

#undef SEND_ERROR
              });

    server.on("/ping", HTTP_GET, [](AsyncWebServerRequest *request)
              {
                  lastPing = millis();
                  request->send(200, "text/plain", "pong"); });

    server.on("/identify", HTTP_GET, [](AsyncWebServerRequest *request)
              {
                  // validate api key
                  if (!request->hasParam("apiKey") || request->getParam("apiKey")->value() != API_KEY)
                  {
                      request->send(403, "application/json", "{\"error\":\"Invalid API key\", \"success\": false}");
                      return;
                  }

                  identifyStart = millis() + 5000; // identify for 10 seconds
                  request->send(200, "application/json", "{\"success\": true}"); });

    server.on("/restart", HTTP_GET, [](AsyncWebServerRequest *request)
              {
                  // validate api key
                  if (!request->hasParam("apiKey") || request->getParam("apiKey")->value() != API_KEY)
                  {
                      request->send(403, "application/json", "{\"error\":\"Invalid API key\", \"success\": false}");
                      return;
                  }

                  request->send(200, "application/json", "{\"success\": true, \"message\": \"Resetting...\"}");
                  delay(1000);
                  ESP.restart(); });

    server.begin();

    digitalWrite(builtinLed, LOW); // Turn off after setup

    fill_solid(leds, ledCount, CRGB::Black);
    FastLED.show();

    // configure time client
    timeClient.begin();
}

bool hasTriedOta = false;

void loop()
{
    if (otaInProgress)
    {
        // don't do anything else during OTA
        // stop server
        return;
    }

    if (WiFi.status() == WL_CONNECTED && !hasTriedOta)
    {
        hasTriedOta = true;
        NetworkClient client;
        Serial.println("Checking for OTA update...");
        httpUpdate.onStart([]()
                           {
                               otaInProgress = true;
                               Serial.println("OTA Update Start");    
                               lastOtaTime = millis();

                                fill_rainbow(leds, ledCount, 0, 255 / ledCount);
                                FastLED.show(); });
        httpUpdate.onEnd([]()
                         {
                             otaInProgress = false;
                             Serial.println("OTA Update End"); 

                             // blink green 3 times
                            for (int i = 0; i < 3; i++)
                            {
                                fill_solid(leds, ledCount, CRGB::Green);
                                FastLED.show();
                                delay(250);
                                fill_solid(leds, ledCount, CRGB::Black);
                                FastLED.show();
                                delay(250);
                            }

                            Serial.println("Rebooting...");
                         });
        httpUpdate.onProgress([](unsigned int progress, unsigned int total)
                              { 
                                // print
                                otaInProgress = true;
                                if (millis() - lastOtaTime > 500) {
                                    Serial.printf("Progress: %u%%\r", (progress / (total / 100)));
                                    lastOtaTime = millis();

                                    // fade from red to green
                                    uint8_t percent = progress / (total / 100);
                                    fill_solid(leds, ledCount, CRGB(255 - (percent * 2.55), percent * 2.55, 0));
                                    FastLED.show();
                                } 
                        });
        httpUpdate.onError([](int err)
                           {
                              otaInProgress = false;
                              Serial.printf("OTA Error: %d - %s\n", err, httpUpdate.getLastErrorString().c_str()); 

                              // blink red 3 times
                              for (int i = 0; i < 3; i++)
                              {
                                  fill_solid(leds, ledCount, CRGB::Red);
                                  FastLED.show();
                                  delay(250);
                                  fill_solid(leds, ledCount, CRGB::Black);
                                  FastLED.show();
                                  delay(250);
                              }

                              // reboot after 5 seconds. yes, this could be a boot-loop, but if that happens then we will notice anyways
                              Serial.println("Rebooting in 5 seconds...");
                              delay(5000);
                              ESP.restart();
                            });

        t_httpUpdate_return ret = httpUpdate.update(client, "http://" OTA_SERVER_BASE_URL "/api/v1/firmware/latest?device_type=esp32dev", GIT_HASH, [](HTTPClient *client)
                                                    {
            client->setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
            client->addHeader("X-Api-Key", OTA_PASSWORD); });
        switch (ret)
        {
        case HTTP_UPDATE_FAILED:
            Serial.printf("HTTP_UPDATE_FAILED Error (%d): %s\n", httpUpdate.getLastError(), httpUpdate.getLastErrorString().c_str());
            break;

        case HTTP_UPDATE_NO_UPDATES:
            Serial.println("HTTP_UPDATE_NO_UPDATES");
            break;

        case HTTP_UPDATE_OK:
            Serial.println("HTTP_UPDATE_OK");
            break;
        }
    }

    wm.process();
    timeClient.update();

    // if no ping received for more than 25 seconds, go to error state
    if (lastPing != 0 && millis() - lastPing > 25000 && tallyState != TALLY_ERROR)
    {
        lastPing = 0; // prevent multiple state changes
        Serial.println("No ping received for 25 seconds, going to error state");
        tallyState = TALLY_ERROR;
    }

    if (identifyStart != 0 && millis() > identifyStart)
    {
        identifyStart = 0; // stop identifying
    }

    if (identifyStart != 0)
    {
        // blink blue
        fill_solid(leds, ledCount, millis() % 500 < 250 ? CRGB::Blue : CRGB::Black);
        FastLED.setBrightness(255);
        FastLED.show();
        return;
    }

    // display current tally state
    switch (tallyState)
    {
    case TALLY_OFF:
        fill_solid(leds, ledCount, CRGB::Black);
        break;
    case TALLY_STANDBY:
        fill_solid(leds, ledCount, CRGB::Green);
        break;
    case TALLY_PROGRAM:
        fill_solid(leds, ledCount, CRGB::Red);
        break;
    case TALLY_PREVIEW:
        fill_solid(leds, ledCount, CRGB::OrangeRed);
        break;
    case TALLY_ERROR:
        fill_solid(leds, ledCount, timeClient.getEpochTime() % 2 < 1 ? CRGB::DarkViolet : CRGB::Black);
        break;
    default:
        fill_solid(leds, ledCount, CRGB::Black);
        break;
    }

    if (config.brightness != FastLED.getBrightness())
    {
        FastLED.setBrightness(config.brightness);
    }

    FastLED.show();
}