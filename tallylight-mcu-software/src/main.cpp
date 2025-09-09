#include <Arduino.h>

#include <WiFi.h>
#include <WiFiManager.h>
#include <ESPmDNS.h>
#include <FastLED.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>

#ifndef ESP32
#error This code is intended to run on the ESP32 platform! Please check your Tools->Board menu.
#endif

// Base Hostname
constexpr const char baseHostname[] = "Tallylight-";

// LEDs
constexpr uint8_t ledstripPin = 5;
constexpr uint8_t ledCount = 6;
constexpr uint8_t builtinLed = 2;    // On-board LED pin
constexpr uint8_t builtinButton = 0; // On-board button pin

// WiFi-Manager
WiFiManager wm;
bool portalRunning = false;
bool startAP = false;
uint64_t timeout = 120;
uint64_t startTime = millis();

enum TallyState : uint8_t
{
    TALLY_OFF = 0,
    TALLY_STANDBY,
    TALLY_PROGRAM,
    TALLY_PREVIEW
    // update populateAllStates if new state is added
} tallyState = TallyState::TALLY_OFF;

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
    default:
        return "UNKNOWN";
    }
}

void populateAllStates(JsonObject &obj)
{
    const auto arr = obj.createNestedArray("states");
    for (uint8_t i = 0; i <= 3; i++)
    {
        TallyState state = static_cast<TallyState>(i);
        JsonObject stateObj = arr.createNestedObject();
        stateObj["id"] = i;
        stateObj["name"] = toString(state);
    }
}

// Setup FastLED
CRGB leds[ledCount];

static AsyncWebServer server(81);

// Function to generate a unique hostname by appending the last 3 bytes of the MAC address
String generateHostname()
{
    uint8_t mac[6];
    WiFi.macAddress(mac);
    char uniquePart[7]; // 6 characters + null terminator
    snprintf(uniquePart, sizeof(uniquePart), "%02X%02X%02X", mac[3], mac[4], mac[5]);
    return String(baseHostname) + String(uniquePart);
}

void setup()
{
    pinMode(builtinLed, OUTPUT);
    digitalWrite(builtinLed, HIGH); // Turn on during boot

    // Initialize FastLED
    FastLED.addLeds<WS2812B, ledstripPin, GRB>(leds, ledCount);
    FastLED.clear();

    fill_solid(leds, ledCount, CRGB::White);
    FastLED.show();

    Serial.begin(115200);
    delay(1000); // Give some time for the Serial Monitor to initialize

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
    wm.setAPStaticIPConfig(IPAddress(10, 0, 1, 1), IPAddress(10, 0, 1, 1), IPAddress(255, 255, 255, 0));
    wm.setConfigPortalBlocking(false); // Non-blocking, so we can do other stuff in loop

    bool res = wm.autoConnect(hostname.c_str(), "tallylight");

    if (!res)
    {
        Serial.println("Failed to connect and hit timeout");
        // Optionally, you can reset the ESP32 to try again
        // ESP.restart();
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

    MDNS.setInstanceName("TallyLight");
    MDNS.addService("http", "tcp", 81);

    server.on("/", HTTP_GET, [&hostname](AsyncWebServerRequest *request)
              { 
                // create json buffer
                JsonDocument doc;

                JsonObject root = doc.to<JsonObject>();
                root["hostname"] = WiFi.getHostname();
                root["ip"] = WiFi.localIP().toString();
                root["tallyState"] = toString(tallyState);
                populateAllStates(root);
                String response;
                if (serializeJson(doc, response) == 0)
                {
                    Serial.println(F("Failed to serialize JSON"));
                    request->send(500, "application/json", "{\"error\":\"Failed to serialize JSON\"}");
                    return;
                }
                request->send(200, "application/json", response); });

    server.on("/setState", HTTP_GET, [](AsyncWebServerRequest *request)
              {
                  if (request->hasParam("state"))
                  {
                      String stateParam = request->getParam("state")->value();
                      int stateValue = stateParam.toInt();
                      if (stateValue >= TALLY_OFF && stateValue <= TALLY_PREVIEW)
                      {
                          tallyState = static_cast<TallyState>(stateValue);
                          request->send(200, "application/json", "{\"status\":\"success\",\"newState\":\"" + toString(tallyState) + "\"}");
                      }
                      else
                      {
                          request->send(400, "application/json", "{\"error\":\"Invalid state value\"}");
                      }
                  }
                  else
                  {
                      request->send(400, "application/json", "{\"error\":\"Missing 'state' parameter\"}");
                  } });

    server.begin();

    digitalWrite(builtinLed, LOW); // Turn off after setup

    fill_solid(leds, ledCount, CRGB::Black);
    FastLED.show();
}

void doWiFiManager()
{
    // is auto timeout portal running
    if (portalRunning)
    {
        wm.process(); // do processing

        // check for timeout
        if ((millis() - startTime) > (timeout * 1000))
        {
            Serial.println("portaltimeout");
            portalRunning = false;
            if (startAP)
            {
                wm.stopConfigPortal();
            }
            else
            {
                wm.stopWebPortal();
            }
        }
    }

    // is configuration portal requested?
    if (digitalRead(builtinButton) == LOW && (!portalRunning))
    {
        if (startAP)
        {
            Serial.println("Button Pressed, Starting Config Portal");
            wm.setConfigPortalBlocking(false);
            wm.startConfigPortal();
        }
        else
        {
            Serial.println("Button Pressed, Starting Web Portal");
            wm.startWebPortal();
        }
        portalRunning = true;
        startTime = millis();
    }
}

void loop()
{
    doWiFiManager();

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
        fill_solid(leds, ledCount, CRGB::Orange);
        break;
    default:
        fill_solid(leds, ledCount, CRGB::Black);
        break;
    }

    FastLED.show();
}