import {Bonjour, Service} from 'bonjour-service';
import express from 'express';
import fs from 'fs';
import cors from 'cors';
import {OBSWebSocket} from 'obs-websocket-js';

const instance = new Bonjour();

const obs = new OBSWebSocket();

// connect to localhost

const tallyLightServices: Service[] = [];

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
    obsPassword: string;
    version: number;
}

export interface SetTallyLightStateSuccessResponse {
    success: true;
    tallyState: TallyLightState;
    brightness: number;
}

export interface SetTallyLightStateFailureResponse {
    success: false;
    error: string;
}

export type SetTallyLightStateResponse = SetTallyLightStateSuccessResponse | SetTallyLightStateFailureResponse;

const currentLightState: Record<FQDN, TallyLightState> = {};

const currentState: {
    previewSceneUuid: SceneUuid | null;
    programSceneUuid: SceneUuid | null
} = {previewSceneUuid: null, programSceneUuid: null};

// Load server configuration
const defaultConfig: ServerConfig = {lights: {}, obsPassword: '', version: 1};

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
    process.exit(1);
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

const instanceBrowser = instance.find({type: 'tallylight'});

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
    const service = tallyLightServices.find(s => s.fqdn === tallyLightFqdn);
    if (!service) {
        console.warn(`Tally light with FQDN ${tallyLightFqdn} not online`);
        return {success: false, error: 'Tally light not online'};
    }

    if (!service.addresses || service.addresses.length === 0) {
        console.warn(`Tally light with FQDN ${tallyLightFqdn} has no addresses`);
        return {success: false, error: 'Tally light has no addresses'};
    }

    const brightness = serverConfig.lights[tallyLightFqdn]?.brightness || 255;


    const url = `http://${service.addresses[0]}:${service.port}/set?state=${state}&brightness=${brightness}`;

    const abortController = new AbortController();
    // timeout of 3s
    const timeout = setTimeout(() => {
        abortController.abort();
    }, 3000);

    try {
        const response = await fetch(url, {signal: abortController.signal});
        clearTimeout(timeout);
        if (!response.ok) {
            console.error(`Failed to set state for ${tallyLightFqdn}:`, response.statusText);
            return {success: false, error: response.statusText};
        }
        const result = await response.json() as SetTallyLightStateResponse;

        if (result.success) {
            return result;
        }
    } catch (error) {
        console.error(`Error setting state for ${tallyLightFqdn}:`, error);
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
    const service = tallyLightServices.find(s => s.fqdn === tallyLightFqdn);
    if (!service) {
        console.warn(`Tally light with FQDN ${tallyLightFqdn} not online`);
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
        return true;
    } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
            console.error(`Error pinging ${tallyLightFqdn}:`, error);
        }
        return false;
    }
};

export const identifyLight = async (tallyLightFqdn: FQDN): Promise<boolean> => {
    const service = tallyLightServices.find(s => s.fqdn === tallyLightFqdn);
    if (!service) {
        console.warn(`Tally light with FQDN ${tallyLightFqdn} not online`);
        return false;
    }

    if (!service.addresses || service.addresses.length === 0) {
        console.warn(`Tally light with FQDN ${tallyLightFqdn} has no addresses`);
        return false;
    }

    const url = `http://${service.addresses[0]}:${service.port}/identify`;

    const abortController = new AbortController();
    // timeout of 3s
    const timeout = setTimeout(() => {
        abortController.abort();
    }, 3000);

    try {
        const response = await fetch(url, {signal: abortController.signal});
        clearTimeout(timeout);
        if (!response.ok) {
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

instanceBrowser.on('up', async (service) => {
    tallyLightServices.push(service);
    console.log('Found tally light service:', service.fqdn);
    await handleUpdate();
    await sendPing(service.fqdn);
});

instanceBrowser.on('down', (service) => {
    console.log('Tally light service went down:', service.fqdn);

    const index = tallyLightServices.findIndex(s => s.fqdn === service.fqdn);
    if (index !== -1) {
        tallyLightServices.splice(index, 1);
    }
});

instanceBrowser.start();

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
            lightsFound: tallyLightServices.map(service => ({
                name: service.name,
                type: service.type,
                protocol: service.protocol,
                port: service.port,
                host: service.host,
                fqdn: service.fqdn,
                addresses: service.addresses,
                txt: service.txt
            })),
            scenes,
            configuredLights: serverConfig.lights,
            currentLightState,
            obsConnected,
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
                console.error(`Failed to set state for ${fqdn}:`, result.error);
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

obs.on('CurrentProgramSceneChanged', async (data) => {
    currentState.programSceneUuid = data.sceneUuid;
    console.log('Program scene changed to:', data.sceneName);

    await handleUpdate();
});

obs.on('CurrentPreviewSceneChanged', async (data) => {
    currentState.previewSceneUuid = data.sceneUuid;
    console.log('Preview scene changed to:', data.sceneName);

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
    });
}, 5000);
