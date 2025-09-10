$(document).ready(() => {
    const identifyLight = async (fqdn) => {
        try {
            const response = await fetch(`/api/identify/${encodeURIComponent(fqdn)}`);

            if (response.ok) {
                alert(`Identification signal sent to ${fqdn}`);
            } else {
                alert(`Failed to send identification signal to ${fqdn}`);
            }
        } catch (error) {
            console.error('Error identifying light:', error);
            alert(`Error identifying light: ${error.message}`);
        }
    };

    const addLight = async (fqdn) => {
        try {
            const response = await fetch(`/api/add/${encodeURIComponent(fqdn)}`);

            if (response.ok) {
                alert(`Light ${fqdn} added successfully`);
                await fetchApi(); // refresh the lists
            } else {
                const errorData = await response.json();
                alert(`Failed to add light ${fqdn}: ${errorData.message || response.statusText}`);
            }
        } catch (error) {
            console.error('Error adding light:', error);
            alert(`Error adding light: ${error.message}`);
        }
    };

    const removeLight = async (fqdn) => {
        try {
            const response = await fetch(`/api/remove/${encodeURIComponent(fqdn)}`);

            if (response.ok) {
                alert(`Light ${fqdn} removed successfully`);
                await fetchApi(); // refresh the lists
            } else {
                const errorData = await response.json();
                alert(`Failed to remove light ${fqdn}: ${errorData.message || response.statusText}`);
            }
        } catch (error) {
            console.error('Error removing light:', error);
            alert(`Error removing light: ${error.message}`);
        }
    };

    const setBrightness = async (fqdn, brightness) => {
        try {
            const response = await fetch(`/api/setBrightness/${encodeURIComponent(fqdn)}/${brightness}`);

            if (response.ok) {
                console.log(`Brightness of ${fqdn} set to ${brightness}`);
            } else {
                const errorData = await response.json();
                alert(`Failed to set brightness of ${fqdn}: ${errorData.message || response.statusText}`);
            }
        } catch (error) {
            console.error('Error setting brightness:', error);
            alert(`Error setting brightness: ${error.message}`);
        }
    };

    const setSceneList = async (fqdn, scenes) => {
        try {
            const response = await fetch(`/api/updateScenes/${encodeURIComponent(fqdn)}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ scenes })
            });

            if (response.ok) {
                console.log(`Scenes of ${fqdn} updated`);
            } else {
                const errorData = await response.json();
                alert(`Failed to update scenes of ${fqdn}: ${errorData.message || response.statusText}`);
            }
        } catch (error) {
            console.error('Error updating scenes:', error);
            alert(`Error updating scenes: ${error.message}`);
        }
    };

    const setColorOfElementToTallylightColor = ($element, state) => {
        switch (state) {
            case 'OFF':
                $element.find('.current-light-color-box').css('background-color', '#000000');
                break;
            case 'STANDBY':
                $element.find('.current-light-color-box').css('background-color', '#00FF00');
                break;
            case 'PROGRAM':
                $element.find('.current-light-color-box').css('background-color', '#FF0000');
                break;
            case 'PREVIEW':
                $element.find('.current-light-color-box').css('background-color', '#FFAA00');
                break;
            case 'ERROR':
                // blink between dark violet and black
                if (Date.now() % 1000 < 500) {
                    $element.find('.current-light-color-box').css('background-color', '#9400D3');
                } else {
                    $element.find('.current-light-color-box').css('background-color', '#000000');
                }
                break;
            default:
                $element.find('.current-light-color-box').css('background-color', '#000000');
                break;
        }
    };

    const populateDiscoveredTallylights = (lightsFound, configuredLights) => {
        /*
            {
                name: service.name,
                type: service.type,
                protocol: service.protocol,
                port: service.port,
                host: service.host,
                fqdn: service.fqdn,
                addresses: service.addresses,
                txt: service.txt
            }
         */
        const $list = $('#discovered-lights-list');

        const filteredLights = lightsFound.filter(light => {
            // filter out lights that are already configured
            return !(configuredLights && light.fqdn in configuredLights);
        });

        // first, remove all items that are not in lightsFound
        $list.find('li').each(function () {
            const $li = $(this);
            const fqdn = $li.data('fqdn');
            const stillExists = filteredLights.some(light => light.fqdn === fqdn);
            if (!stillExists) {
                $li.remove();
            }
        });

        // now, add new items
        filteredLights.forEach(light => {
            const existing = $list.find(`li.discoveredLight[data-fqdn="${light.fqdn}"]`);
            if (existing.length === 0) {
                const $li = $(`
                    <li data-fqdn="${light.fqdn}" data-port="${light.port}" data-name="${light.name}" class="list-group-item discoveredLight">
                        <strong>${light.name}</strong> (${light.type}) - ${light.addresses.join(', ')}
                        <br>
                        <small>${light.fqdn}:${light.port}</small>
                        <br>
                        <button class="btn btn-sm btn-primary configure-light-btn">Add</button>
                        <button class="btn btn-sm btn-secondary identify-light-btn">Identify</button>
                    </li>
                `);
                $list.append($li);

                // bind events
                $li.find('.configure-light-btn').on('click', () => {
                    addLight(light.fqdn);
                });

                $li.find('.identify-light-btn').on('click', () => {
                    identifyLight(light.fqdn);
                });
            }
        });

        // if no lights found, show a message

        if (filteredLights.length === 0) {
            $list.empty();
            // bootstrap alert
            $list.append(`
                <div class="alert alert-info" role="alert">
                    No new tally lights found. Make sure your tally lights are powered on and connected to the same network as this server.
                </div>
            `);
        }
    };

    const populateConfiguredTallylights = (lightsFound, configuredLights, currentLightState, obsScenes) => {
        const $list = $('#configured-lights-list');

        // first, remove all items that are not in configuredLights
        $list.find('li').each(function () {
            const $li = $(this);
            const fqdn = $li.data('fqdn');
            const stillExists = configuredLights && fqdn in configuredLights;
            if (!stillExists) {
                $li.remove();
            }
        });

        // now, add new items
        // the items should show their data, and also their config. Config consists of:
        // - A number input from 0-255 for brightness
        // - A list of scenes. Each scene has a checkbox to enable/disable it for this light. This should be collapsible.
        // - Its current state (brightness, currentLightState)
        if (configuredLights) {
            Object.entries(configuredLights).forEach(([fqdn, config]) => {
                const entryFromDiscovery = lightsFound.find(light => light.fqdn === fqdn);

                if (!entryFromDiscovery) {
                    // if the light is not found in discovery, we won't display it
                    console.warn(`Configured light ${fqdn} not found in discovery`);
                    return;
                }

                const existing = $list.find(`li.configuredLight[data-fqdn="${fqdn}"]`);
                if (existing.length === 0) {
                    const $li = $(`
                        <li data-fqdn="${fqdn}" class="list-group-item configuredLight">
                            <strong>${entryFromDiscovery.name}</strong> (${entryFromDiscovery.type}) - ${entryFromDiscovery.addresses.join(', ')}
                            <br>
                            <small>${entryFromDiscovery.fqdn}:${entryFromDiscovery.port}</small>
                            <br><br>
                            <div class="mb-3">
                                <label class="form-label">Brightness (0-255)</label>
                                <input type="number" class="form-control brightness-input" min="0" max="255" value="${config.brightness || 0}">
                            </div>
                            <div class="mb-3">
                                <label class="form-label">Current Light State: </label>
                                <span class="current-light-state">${currentLightState[fqdn] || 'Unknown'}</span>
                                <div class="current-light-color-box" style="width: 64px; height: 64px; background-color: ${currentLightState[fqdn] || '#000'}; border: 1px solid #ccc; display: inline-block; vertical-align: middle; margin-left: 10px;"></div>
                            </div>
                            <div class="mb-3">
                                <button class="btn btn-sm btn-danger remove-light-btn">Remove</button>
                                <button class="btn btn-sm btn-secondary identify-light-btn">Identify</button>
                            </div>
                            <hr>
                            <!-- Scenes configuration. it should be collapsible -->
                            <div class="mb-3 collapse" id="scenes-config-${fqdn.replace(/\W/g, '_')}">
                                <label class="form-label">Scenes</label>
                                <div class="scenes-list" data-touched="false">
                                    ${obsScenes && obsScenes.length > 0 ? obsScenes.map(scene => {
                                        // scene = { sceneIndex: number, sceneName: string, sceneUuid: string }. the uuid is what will be saved in config
                                        const isChecked = config.visibleInScenes && config.visibleInScenes.includes(scene.sceneUuid) ? 'checked' : '';
                                        return `
                                            <div class="form-check">
                                                <input class="form-check-input scene-checkbox" type="checkbox" value="${scene.sceneUuid}" id="scene-${fqdn.replace(/\W/g, '_')}-${scene.sceneUuid}" ${isChecked} data-fqdn="${fqdn}" data-scene-uuid="${scene.sceneUuid}">
                                                <label class="form-check-label" for="scene-${fqdn.replace(/\W/g, '_')}-${scene.sceneUuid}">
                                                    ${scene.sceneName}
                                                </label>
                                            </div>
                                        `;
                                    }).join('') : '<p>No scenes found in OBS.</p>'}
                                </div>
                                <button class="btn btn-sm btn-primary save-scenes-btn">Save Scenes Configuration</button> 
                           </div>
                            <button class="btn btn-sm btn-info" data-bs-toggle="collapse" data-bs-target="#scenes-config-${fqdn.replace(/\W/g, '_')}" aria-expanded="false" aria-controls="scenes-config-${fqdn.replace(/\W/g, '_')}">Toggle Scenes Configuration</button>
                        </li>
                    `);
                    $list.append($li);

                    // set initial values
                    $li.find('.brightness-input').val(config.brightness || 0);
                    const currentState = currentLightState[fqdn];

                    if (currentState) {
                        $li.find('.current-light-state').text(currentState || 'Unknown');

                        setColorOfElementToTallylightColor($li, currentLightState[fqdn]);
                    }

                    // set scenes
                    if (obsScenes && obsScenes.length > 0 && config.visibleInScenes && Array.isArray(config.visibleInScenes)) {
                        obsScenes.forEach(scene => {
                            const $checkbox = $li.find(`.scene-checkbox[data-scene-uuid="${scene.sceneUuid}"]`);
                            if ($checkbox.length > 0) {
                                if (config.visibleInScenes.includes(scene.sceneUuid)) {
                                    $checkbox.prop('checked', true);
                                } else {
                                    $checkbox.prop('checked', false);
                                }
                            }
                        });
                    }

                    // bind events
                    $li.find('.remove-light-btn').on('click', () => {
                        if (confirm(`Are you sure you want to remove ${entryFromDiscovery.name}?`)) {
                            removeLight(fqdn);
                        }
                    });

                    $li.find('.identify-light-btn').on('click', () => {
                        identifyLight(fqdn);
                    });

                    $li.find('.brightness-input').on('change', (e) => {
                        // set data-touched to true
                        e.target.dataset.touched = 'true';

                        let val = parseInt(e.target.value, 10);
                        if (isNaN(val) || val < 0) val = 0;
                        if (val > 255) val = 255;
                        e.target.value = val;
                        setBrightness(fqdn, val);
                    });

                    $li.find('.scene-checkbox').on('change', () => {
                        // set data-touched to true
                        $li.find('.scenes-list')[0].dataset.touched = 'true';
                    });

                    $li.find('.save-scenes-btn').on('click', () => {
                        const selectedScenes = [];
                        $li.find('.scene-checkbox:checked').each(function () {
                            selectedScenes.push($(this).data('scene-uuid'));
                        });
                        setSceneList(fqdn, selectedScenes);
                    });
                } else {
                    // update current state and brightness
                    const currentState = currentLightState[fqdn];

                    if (currentState) {
                        existing.find('.current-light-state').text(currentState || 'Unknown');

                        setColorOfElementToTallylightColor(existing, currentState);
                    }

                    const $brightnessInput = existing.find('.brightness-input');
                    if ($brightnessInput[0].dataset.touched !== 'true') {
                        $brightnessInput.val(config.brightness || 0);
                    }

                    // update scenes
                    const $scenesList = existing.find('.scenes-list');
                    if ($scenesList[0].dataset.touched !== 'true') {
                        if (obsScenes && obsScenes.length > 0 && config.visibleInScenes && Array.isArray(config.visibleInScenes)) {
                            obsScenes.forEach(scene => {
                                const $checkbox = existing.find(`.scene-checkbox[data-scene-uuid="${scene.sceneUuid}"]`);
                                if ($checkbox.length > 0) {
                                    if (config.visibleInScenes.includes(scene.sceneUuid)) {
                                        $checkbox.prop('checked', true);
                                    } else {
                                        $checkbox.prop('checked', false);
                                    }
                                }
                            });
                        }
                    }
                }
            });
        } else {
            $list.empty();
            // bootstrap alert
            $list.append(`
                <div class="alert alert-info" role="alert">
                    No tally lights configured. Add a discovered light to configure it.
                </div>
            `);
        }
    };

    const populateObsStatus = (obsConnected) => {
        const $status = $('#obs-status');

        const alertElement = $status.find('.alert');
        if (obsConnected) {
            alertElement.removeClass('alert-danger').addClass('alert-success');
        } else {
            alertElement.removeClass('alert-success').addClass('alert-danger');
        }

        const statusMessageElement = $status.find('span#obs-status-message');

        if (obsConnected) {
            statusMessageElement.text('OBS is connected.');
        } else {
            statusMessageElement.text('OBS is not connected. Please ensure OBS is running and the WebSocket server is enabled.');
        }
    };

    const fetchApi = async () => {
        const response = await fetch('/api/data');

        const data = await response.json();
        console.log(data);

        // data = {
        //    lightsFound: [...],
        //    scenes: [...],
        //    configuredLights: [...],
        //    currentLightState: {...}
        //    obsConnected: true/false
        // }

        if (data.lightsFound && data.configuredLights) {
            populateDiscoveredTallylights(data.lightsFound, data.configuredLights);

            if (data.currentLightState && data.scenes) {
                populateConfiguredTallylights(data.lightsFound, data.configuredLights, data.currentLightState, data.scenes);
            }
        }

        if (data.obsConnected !== undefined) {
            populateObsStatus(data.obsConnected);
        }

        // populate debug info
        $('#debug').text(JSON.stringify(data, null, 2));
    };

    fetchApi();

    setInterval(fetchApi, 1500);

    // toggle visually-hidden class on #debug depending on if search params has debug=true
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('debug') === 'true') {
        $('#debug').removeClass('visually-hidden');
    } else {
        $('#debug').addClass('visually-hidden');
    }
});
