import {Bonjour, Browser, Service} from 'bonjour-service';
import express from 'express';
import fs from 'fs';
import cors from 'cors';
import {OBSWebSocket} from 'obs-websocket-js';

const obs = new OBSWebSocket();

// connect to localhost

const tallyLightServices: { service: Service; lastPing: Date | null }[] = [];

export type FQDN = string;

export type SceneUuid = string;

export type TallyLightState = 'OFF' | 'STANDBY' | 'PROGRAM' | 'PREVIEW' | 'ERROR';

let obsConnected = false;

export interface TallyLightMapping {
    brightness: number; // 0-255
    visibleInScenes: SceneUuid[];
}

export interface ServerConfig {
    lights: Record<FQDN, TallyLightMapping>;
    obsAddress: string;
    obsPassword: string;
    apiKey: string;
    version: number;
}

export interface SetTallyLightStateSuccessResponse {
    success: true;
    tallyState: TallyLightState;
    brightness: number;
}

class TallyLightError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TallyLightError';
    }
}

class TallyLightOfflineError extends TallyLightError {
    constructor(message: string) {
        super(message);
        this.name = 'TallyLightOfflineError';
    }
}

class TallyLightInvalidApiKeyError extends TallyLightError {
    constructor(message: string) {
        super(message);
        this.name = 'TallyLightInvalidApiKeyError';
    }
}

export interface SetTallyLightStateFailureResponse {
    success: false;
    error: string | TallyLightError;
}

export type SetTallyLightStateResponse = SetTallyLightStateSuccessResponse | SetTallyLightStateFailureResponse;

const currentLightState: Record<FQDN, TallyLightState> = {};

export interface TallylightInfo {
    hostname: string;
    ip: string;
    tallyState: TallyLightState;
    gitHash: string;
    gitDirty: 'dirty' | 'clean';
    brightness: number;
    millis: number;
    rssi: number;
    utcEpoch: number;
}

const tallylightInfos: Record<FQDN, TallylightInfo> = {};

const currentState: {
    previewSceneUuid: SceneUuid | null;
    programSceneUuid: SceneUuid | null
} = {previewSceneUuid: null, programSceneUuid: null};

// Load server configuration
const defaultConfig: ServerConfig = {
    lights: {},
    obsAddress: 'ws://localhost:4455',
    obsPassword: '',
    apiKey: '',
    version: 2
};

let serverConfig: ServerConfig = defaultConfig;

const configPath = 'config.json';

const configExists = fs.existsSync(configPath);

if (!configExists) {
    console.warn('Configuration file not found, creating default at', configPath);
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
}

try {
    const configData = fs.readFileSync(configPath, 'utf-8');
    serverConfig = JSON.parse(configData);
    console.log('Configuration loaded successfully');
} catch (error) {
    console.error('Error loading configuration, using default:', error);
    serverConfig = defaultConfig;
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
}

// if version does not match with default, merge
if (serverConfig.version !== defaultConfig.version) {
    console.warn('Configuration version mismatch, merging with default');
    serverConfig = {...defaultConfig, ...serverConfig, version: defaultConfig.version};
    fs.writeFileSync(configPath, JSON.stringify(serverConfig, null, 2), 'utf-8');
    console.log('Configuration updated to version', serverConfig.version);
}

for (const fqdn of Object.keys(serverConfig.lights)) {
    currentLightState[fqdn] = 'OFF';
}

export const updateConfig = async () => {
    try {
        fs.writeFileSync(configPath, JSON.stringify(serverConfig, null, 2), 'utf-8');
        console.log('Configuration saved successfully');
    } catch (error) {
        console.error('Error saving configuration:', error);
    }

    await handleUpdate();
};

export const setTallyLightState = async (tallyLightFqdn: FQDN, state: TallyLightState): Promise<SetTallyLightStateResponse> => {
    const service = tallyLightServices.find(s => s.service.fqdn === tallyLightFqdn)?.service;
    if (!service) {
        return {success: false, error: new TallyLightOfflineError(`Tally light with FQDN ${tallyLightFqdn} not online`)};
    }

    if (!service.addresses || service.addresses.length === 0) {
        console.warn(`Tally light with FQDN ${tallyLightFqdn} has no addresses`);
        return {success: false, error: 'Tally light has no addresses'};
    }

    const brightness = serverConfig.lights[tallyLightFqdn]?.brightness || 255;


    const url = `http://${service.addresses[0]}:${service.port}/set?state=${state}&brightness=${brightness}&apiKey=${serverConfig.apiKey}`;

    const abortController = new AbortController();
    // timeout of 3s
    const timeout = setTimeout(() => {
        abortController.abort();
    }, 3000);

    try {
        const response = await fetch(url, {signal: abortController.signal});
        clearTimeout(timeout);
        if (!response.ok) {
            // check if 403
            if (response.status === 403) {
                return {success: false, error: new TallyLightInvalidApiKeyError('Invalid API key')};
            }

            console.error(`Failed to set state for ${tallyLightFqdn}:`, response.statusText);
            return {success: false, error: response.statusText};
        }
        const result = await response.json() as SetTallyLightStateResponse;

        if (result.success) {
            return result;
        }
    } catch (error) {
        if (error instanceof Error) {
            console.warn(`Error setting state for ${tallyLightFqdn}:`, error.message);
        }
        return {success: false, error: 'Network error'};
    }

    return {success: false, error: 'Unknown error'};
};
export const executeForEachLight = (callback: (fqdn: FQDN, mapping: TallyLightMapping) => void) => {
    for (const [fqdn, mapping] of Object.entries(serverConfig.lights)) {
        callback(fqdn, mapping);
    }
}

export const sendPing = async (tallyLightFqdn: FQDN): Promise<boolean> => {
    const service = tallyLightServices.find(s => s.service.fqdn === tallyLightFqdn)?.service;
    if (!service) {
        console.warn('[sendPing]', `Tally light with FQDN ${tallyLightFqdn} not online`);
        return false;
    }

    if (!service.addresses || service.addresses.length === 0) {
        console.warn(`Tally light with FQDN ${tallyLightFqdn} has no addresses`);
        return false;
    }

    const url = `http://${service.addresses[0]}:${service.port}/ping`;

    const abortController = new AbortController();
    // timeout of 3s
    const timeout = setTimeout(() => {
        abortController.abort();
    }, 3000);

    try {
        const response = await fetch(url, {signal: abortController.signal});
        clearTimeout(timeout);
        if (!response.ok) {
            console.error(`Failed to ping ${tallyLightFqdn}:`, response.statusText);
            return false;
        }

        // set last ping time
        const light = tallyLightServices.find(s => s.service.fqdn === tallyLightFqdn);
        if (light) {
            light.lastPing = new Date();
        }

        return true;
    } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
            console.error(`Error pinging ${tallyLightFqdn}:`, error);
        }
        return false;
    }
};

export const identifyLight = async (tallyLightFqdn: FQDN): Promise<boolean> => {
    const service = tallyLightServices.find(s => s.service.fqdn === tallyLightFqdn)?.service;
    if (!service) {
        console.warn('[identifyLight]', `Tally light with FQDN ${tallyLightFqdn} not online`);
        return false;
    }

    if (!service.addresses || service.addresses.length === 0) {
        console.warn(`Tally light with FQDN ${tallyLightFqdn} has no addresses`);
        return false;
    }

    const url = `http://${service.addresses[0]}:${service.port}/identify?apiKey=${serverConfig.apiKey}`;

    const abortController = new AbortController();
    // timeout of 3s
    const timeout = setTimeout(() => {
        abortController.abort();
    }, 3000);

    try {
        const response = await fetch(url, {signal: abortController.signal});
        clearTimeout(timeout);
        if (!response.ok) {
            if (response.status === 403) {
                console.error(`Failed to identify ${tallyLightFqdn}: Invalid API key`);
                return false;
            }

            console.error(`Failed to identify ${tallyLightFqdn}:`, response.statusText);
            return false;
        }
        return true;
    } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
            console.error(`Error identifying ${tallyLightFqdn}:`, error);
        }
        return false;
    }
};

export const fetchTallylightInfos = async (tallyLightFqdn: FQDN): Promise<TallylightInfo | null> => {
    // fetch "/" endpoint
    const service = tallyLightServices.find(s => s.service.fqdn === tallyLightFqdn)?.service;
    if (!service) {
        console.warn('[fetchTallylightInfos]', `Tally light with FQDN ${tallyLightFqdn} not online`);
        return null;
    }

    if (!service.addresses || service.addresses.length === 0) {
        console.warn(`Tally light with FQDN ${tallyLightFqdn} has no addresses`);
        return null;
    }

    const url = `http://${service.addresses[0]}:${service.port}/`;

    const abortController = new AbortController();
    // timeout of 3s
    const timeout = setTimeout(() => {
        abortController.abort();
    }, 3000);

    try {
        const response = await fetch(url, {signal: abortController.signal});
        clearTimeout(timeout);
        if (!response.ok) {
            console.error(`Failed to fetch info from ${tallyLightFqdn}:`, response.statusText);
            return null;
        }
        const result = await response.json() as TallylightInfo;
        tallylightInfos[tallyLightFqdn] = result;
        return result;
    } catch (error) {
        if (error instanceof Error) {
            if (error.name !== 'AbortError') {
                console.error(`Error fetching info from ${tallyLightFqdn}:`, error.message);
            }
        }
    }

    return null;
};

export const restartTallyLight = async (tallyLightFqdn: FQDN): Promise<boolean> => {
    const service = tallyLightServices.find(s => s.service.fqdn === tallyLightFqdn)?.service;
    if (!service) {
        console.warn('[restartTallyLight]', `Tally light with FQDN ${tallyLightFqdn} not online`);
        return false;
    }

    if (!service.addresses || service.addresses.length === 0) {
        console.warn(`Tally light with FQDN ${tallyLightFqdn} has no addresses`);
        return false;
    }

    const url = `http://${service.addresses[0]}:${service.port}/restart?apiKey=${serverConfig.apiKey}`;

    const abortController = new AbortController();
    // timeout of 3s
    const timeout = setTimeout(() => {
        abortController.abort();
    }, 3000);

    try {
        const response = await fetch(url, {signal: abortController.signal});
        clearTimeout(timeout);
        if (!response.ok) {
            if (response.status === 403) {
                console.error(`Failed to restart ${tallyLightFqdn}: Invalid API key`);
                return false;
            }

            console.error(`Failed to restart ${tallyLightFqdn}:`, response.statusText);
            return false;
        }
        return true;
    } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
            console.error(`Error restarting ${tallyLightFqdn}:`, error);
        }
        return false;
    }
};

let instance: Bonjour | null = null;
let instanceBrowser: Browser | null = null;

const restartServiceBrowser = () => {
    try {
        console.log('Restarting service browser to avoid potential issues');

        instanceBrowser?.stop();
        instanceBrowser?.removeAllListeners('up');
        instanceBrowser?.removeAllListeners('down');

        instance?.destroy();

        instance = new Bonjour();

        instanceBrowser = instance.find({type: 'tallylight'});

        instanceBrowser.on('up', async (service) => {
            tallyLightServices.push({ service, lastPing: null });
            console.log('Found tally light service:', service.fqdn);
            await handleUpdate();
            await sendPing(service.fqdn);
        });

        instanceBrowser.on('down', (service) => {
            console.log('Tally light service went down:', service.fqdn);

            const index = tallyLightServices.findIndex(s => s.service.fqdn === service.fqdn);
            if (index !== -1) {
                tallyLightServices.splice(index, 1);
            }
        });

        instanceBrowser.start();
        instanceBrowser.update();
        console.log('Service browser restarted successfully');
    } catch (error) {
        console.error('Error restarting service browser:', error);
    }
};

// add timeout that removes services that have not pinged in the last 15 seconds
setInterval(() => {
    const now = new Date();
    let removed = false;
    for (let i = tallyLightServices.length - 1; i >= 0; i--) {
        const light = tallyLightServices[i];

        if (!light) continue;

        const {service, lastPing} = light;

        if (lastPing && (now.getTime() - lastPing.getTime() > 15000)) {
            console.log('Removing tally light service due to timeout:', service.fqdn);
            tallyLightServices.splice(i, 1);
            removed = true;
        }
    }
    if (removed) {
        handleUpdate().catch(error => {
            console.error('Error updating lights after removing timed out services:', error);
        });
    }
}, 5000);

const app = express();

app.use(cors());

app.use(express.json());

app.get('/api/data', async (_req, res) => {
    let scenes: object[] = [];

    try {
        scenes = (await obs.call('GetSceneList')).scenes;
    } catch (error) {
        console.error('Error fetching scenes from OBS:', error);
    }

    try {
        res.json({
            lightsFound: tallyLightServices.map(({ service, lastPing }) => ({
                name: service.name,
                type: service.type,
                protocol: service.protocol,
                port: service.port,
                host: service.host,
                fqdn: service.fqdn,
                addresses: service.addresses,
                txt: service.txt,
                lastPing,
            })),
            scenes,
            configuredLights: serverConfig.lights,
            currentLightState,
            obsConnected,
            tallylightInfos,
        });
    } catch (error) {
        console.error('Error fetching list:', error);
        res.status(500).json({error: 'Internal Server Error'});
    }
});

app.get('/api/identify/:fqdn', async (req, res) => {
    const {fqdn} = req.params;

    const success = await identifyLight(fqdn);
    if (success) {
        res.json({success: true});
    } else {
        res.status(500).json({success: false, error: 'Failed to identify light'});
    }
});

app.get('/api/setBrightness/:fqdn/:brightness', async (req, res) => {
    const {fqdn, brightness} = req.params;
    const brightnessValue = parseInt(brightness, 10);

    if (isNaN(brightnessValue) || brightnessValue < 0 || brightnessValue > 255) {
        res.status(400).json({success: false, error: 'Brightness must be an integer between 0 and 255'});
        return;
    }

    if (!serverConfig.lights[fqdn]) {
        res.status(400).json({success: false, error: 'Light not configured'});
        return;
    }

    serverConfig.lights[fqdn].brightness = brightnessValue;

    await updateConfig();

    res.json({success: true});
});

app.get('/api/add/:fqdn', async (req, res) => {
    const {fqdn} = req.params;

    if (serverConfig.lights[fqdn]) {
        res.status(400).json({success: false, error: 'Light already configured'});
        return;
    }

    serverConfig.lights[fqdn] = {brightness: 255, visibleInScenes: []};
    currentLightState[fqdn] = 'OFF';

    await updateConfig();

    res.json({success: true});
});

app.get('/api/remove/:fqdn', async (req, res) => {
    const {fqdn} = req.params;

    if (!serverConfig.lights[fqdn]) {
        res.status(400).json({success: false, error: 'Light not configured'});
        return;
    }

    delete serverConfig.lights[fqdn];
    delete currentLightState[fqdn];

    await updateConfig();

    res.json({success: true});
});

app.post('/api/updateScenes/:fqdn', async (req, res) => {
    const {scenes} = req.body;
    const {fqdn} = req.params;

    if (!fqdn || !Array.isArray(scenes)) {
        res.status(400).json({success: false, error: 'Invalid request body'});
        return;
    }

    if (!serverConfig.lights[fqdn]) {
        res.status(400).json({success: false, error: 'Light not configured'});
        return;
    }

    serverConfig.lights[fqdn].visibleInScenes = scenes;

    await updateConfig();

    res.json({success: true});
});

app.get('/api/restart/:fqdn', async (req, res) => {
    const {fqdn} = req.params;

    const success = await restartTallyLight(fqdn);
    if (success) {
        res.json({success: true});
    } else {
        res.status(500).json({success: false, error: 'Failed to restart light'});
    }
});

const allowedConfigGetter: (keyof ServerConfig)[] = ['apiKey', 'obsAddress', 'obsPassword'];
const allowedConfigSetter: (keyof ServerConfig)[] = ['apiKey', 'obsAddress', 'obsPassword'];

app.get('/api/config', async (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="config.json"');
    res.setHeader('Content-Type', 'application/json');

    const filteredConfig: Partial<ServerConfig> = {};
    for (const key in serverConfig) {
        if (allowedConfigGetter.includes(key as keyof ServerConfig)) {
            (filteredConfig as any)[key] = (serverConfig)[key as keyof ServerConfig];
        }
    }

    res.send(JSON.stringify(filteredConfig, null, 2));
});

app.post('/api/config/:key', async (req, res) => {
    const {key} = req.params;
    const {value} = req.body;

    if (!allowedConfigSetter.includes(key as keyof ServerConfig)) {
        res.status(400).json({success: false, error: 'Invalid configuration key'});
        return;
    }

    if (typeof value !== 'string') {
        res.status(400).json({success: false, error: 'Value must be a string'});
        return;
    }

    (serverConfig as any)[key] = value;

    await updateConfig();

    res.json({success: true});
});

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || 'localhost';

app.use(express.static('www'));

// serve jquery
app.use('/jquery/dist', express.static('node_modules/jquery/dist/'));

// serve bootstrap
app.use('/bootstrap/dist', express.static('node_modules/bootstrap/dist/'));

// serve bootstrap icons
app.use('/bootstrap-icons/font/', express.static('node_modules/bootstrap-icons/font/'));

app.listen(PORT, HOST, () => {
    console.log(`Server is running at http://${HOST}:${PORT}`);
});

export const handleUpdate = async () => {
    const updateCurrentState = async () => {
        if (!obsConnected) {
            console.warn('Not connected to OBS, skipping state update');
            return;
        }

        try {
            const currentProgram = await obs.call('GetCurrentProgramScene');
            currentState.programSceneUuid = currentProgram.currentProgramSceneUuid;

            const currentPreview = await obs.call('GetCurrentPreviewScene');
            currentState.previewSceneUuid = currentPreview.currentPreviewSceneUuid;

            console.log('Updated program scene:', currentState.programSceneUuid, currentProgram.currentProgramSceneName);
            console.log('Updated preview scene:', currentState.previewSceneUuid, currentPreview.currentPreviewSceneName);
        } catch (error) {
            console.error('Error fetching scenes from OBS:', error);
        }
    };

    await updateCurrentState();

    const determineState = (fqdn: string) => {
        try {
            const mapping = serverConfig.lights[fqdn];
            if (!mapping) {
                console.warn(`No mapping found for ${fqdn}, skipping`);
                return;
            }

            if (!currentState.programSceneUuid && !currentState.previewSceneUuid) {
                currentLightState[fqdn] = 'ERROR';
                return;
            }

            if (currentState.programSceneUuid && mapping.visibleInScenes.includes(currentState.programSceneUuid)) {
                currentLightState[fqdn] = 'PROGRAM';
            } else if (currentState.previewSceneUuid && mapping.visibleInScenes.includes(currentState.previewSceneUuid)) {
                currentLightState[fqdn] = 'PREVIEW';
            } else if (mapping.visibleInScenes.length > 0) {
                currentLightState[fqdn] = 'STANDBY';
            } else {
                currentLightState[fqdn] = 'OFF';
            }
        } catch (error) {
            console.error(`Error determining state for light ${fqdn}:`, error);
            return;
        }
    };

    const updateState = async (fqdn: string) => {
        try {
            const state = currentLightState[fqdn];

            if (!state) {
                console.warn(`No current state for ${fqdn}, skipping`);
                return;
            }

            const result = await setTallyLightState(fqdn, state);
            if (!result.success) {
                if (!(result.error instanceof TallyLightOfflineError)) {
                    console.error(`Failed to set state for ${fqdn}:`, result.error);
                }
            }
        } catch (error) {
            console.error(`Error processing light ${fqdn}:`, error);
        }
    };

    let promises: Promise<void>[] = [];

    executeForEachLight(async (fqdn) => {
        promises.push((async () => {
            determineState(fqdn);
            await updateState(fqdn);
        })());
    });

    await Promise.all(promises).catch(error => {
        console.error('Error updating lights:', error);
    });
};

obs.on('ConnectionOpened', async () => {
    obsConnected = true;
    console.log('Connected to OBS successfully');
});

obs.on('ConnectionClosed', () => {
    obsConnected = false;
    console.warn('Connection to OBS closed, attempting to reconnect in 5 seconds...');
    setTimeout(async () => {
        try {
            await obs.connect('ws://localhost:4455', serverConfig.obsPassword);
            console.log('Reconnected to OBS successfully');
        } catch (error) {
            console.error('Failed to reconnect to OBS:', error);
        }
    }, 5000);
});

obs.on('ConnectionError', (error) => {
    obsConnected = false;
    console.error('OBS WebSocket error:', error);
});

// we cannot use the data from the event because it is not in sync with preview/program
obs.on('CurrentProgramSceneChanged', async () => {
    await handleUpdate();
});

obs.on('CurrentPreviewSceneChanged', async () => {
    await handleUpdate();
});

try {
    await obs.connect('ws://localhost:4455', serverConfig.obsPassword);

    try {
        const currentProgram = await obs.call('GetCurrentProgramScene');
        currentState.programSceneUuid = currentProgram.currentProgramSceneUuid;

        const currentPreview = await obs.call('GetCurrentPreviewScene');
        currentState.previewSceneUuid = currentPreview.currentPreviewSceneUuid;

        console.log('Initial program scene:', currentState.programSceneUuid, currentProgram.currentProgramSceneName);
        console.log('Initial preview scene:', currentState.previewSceneUuid, currentPreview.currentPreviewSceneName);

        await handleUpdate();
    } catch (error) {
        console.error('Error fetching initial scenes from OBS:', error);
    }
} catch (error) {
    console.error('Failed to connect to OBS:', error);
}

setInterval(async () => {
    executeForEachLight(async (fqdn) => {
        await sendPing(fqdn);
        await fetchTallylightInfos(fqdn);
    });
}, 10000);

restartServiceBrowser();

// restart service browser every minute to avoid potential issues
setInterval(() => {
    try {
        console.log('Restarting service browser to avoid potential issues');
        restartServiceBrowser();
        console.log('Service browser restarted successfully');
    } catch (error) {
        console.error('Error restarting service browser:', error);
    }
}, 60000);

// send update every 15 seconds in case of missed events
setInterval(async () => {
    await handleUpdate();
}, 15000);

process.on('SIGINT', async () => {
    console.log('Shutting down...');
    instanceBrowser?.stop();
    instance?.destroy();
    await obs.disconnect();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    instanceBrowser?.stop();
    instance?.destroy();
    await obs.disconnect();
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
});
