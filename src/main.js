/* global mapboxgl */
import {extrudeGeoJSON} from 'geometry-extrude';
import {
    application,
    plugin,
    geometry as builtinGeometries,
    Texture2D,
    Geometry,
    Vector3
} from 'claygl';
import {VectorTile} from '@mapbox/vector-tile';
import Protobuf from 'pbf';
import * as dat from 'dat.gui';
import ClayAdvancedRenderer from 'claygl-advanced-renderer';
import LRU from 'lru-cache';
import quickhull from 'quickhull3d';
import toOBJ from './toOBJ';
import JSZip from 'jszip';
import tessellate from './tessellate';
import vec2 from 'claygl/src/glmatrix/vec2';

const mvtCache = LRU(50);;

import distortion from './distortion';

const maptalks = require('maptalks');

let downloading = false;

const config = {
    radius: 60,
    curveness: 1,
    showEarth: true,
    earthColor: '#EDE3B7',
    showBuildings: true,
    buildingsColor: '#D59674',
    showRoads: true,
    roadsColor: '#253446',
    showWater: false,
    waterColor: '#58949C',
    showCloud: true,
    cloudColor: '#fff',

    autoRotateSpeed: 0,
    sky: true,
    downloadOBJ: () => {
        if (downloading) {
            return;
        }
        const {obj, mtl} = toOBJ(app.scene, {
            mtllib: 'city'
        });
        const zip = new JSZip();
        zip.file('city.obj', obj);
        zip.file('city.mtl', mtl);
        zip.generateAsync({type: 'blob', compression: 'DEFLATE' })
            .then(content => {
                downloading = false;
                saveAs(content, 'city.zip');
            }).catch(e => {
                downloading = false;
                console.error(e.toString());
            });
        // Behind all processing in case some errror happens.
        downloading = true;
    },
    randomCloud: () => {
        app.methods.generateCloud();
    }
};

const mvtUrlTpl = 'https://{s}.tile.nextzen.org/tilezen/vector/v1/256/all/{z}/{x}/{y}.mvt?api_key=zPG-aKmNQQ60P7Gwz7WgDg';

const mainLayer = new maptalks.TileLayer('base', {
    tileSize: [256, 256],
    urlTemplate: 'http://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c']
});
const zoomBase = 16;
const map = new maptalks.Map('map-main', {
    // center: [-0.113049, 51.498568],
    // center: [-73.97332, 40.76462],
    center: [-73.215027, 44.479710],
    zoom: zoomBase,
    baseLayer: mainLayer
});
map.setMinZoom(zoomBase);
map.setMaxZoom(zoomBase);

const faces = [
    'pz', 'px', 'nz',
    'py', 'nx', 'ny'
];

const vectorElements = [{
    type: 'buildings',
    geometryType: 'polygon',
    depth: feature => {
        return (feature.properties.height || 30) / 3 + 1;
    }
}, {
    type: 'roads',
    geometryType: 'polyline',
    depth: 1
}, {
    type: 'water',
    geometryType: 'polygon',
    depth: 2
}];

function subdivideLineFeatures(lineFeatures, maxDist) {

    const v = [];
    function addPoints(points) {
        const newPoints = [];
        for (let i = 0; i < points.length - 1; i++) {
            vec2.sub(v, points[i + 1], points[i]);
            const dist = vec2.len(v);
            vec2.scale(v, v, 1 / dist);
            newPoints.push(points[i]);
            for (let d = maxDist; d < dist; d += maxDist) {
                newPoints.push(vec2.scaleAndAdd([], points[i], v, d));
            }
        }
        newPoints.push(points[points.length - 1]);
        return newPoints;
    }

    lineFeatures.forEach(feature => {
        const geometry = feature.geometry;
        if (geometry.type === 'MultiLineString') {
            for (let i = 0; i < geometry.coordinates.length; i++) {
                geometry.coordinates[i] = addPoints(geometry.coordinates[i]);
            }
        }
        else if (geometry.type === 'LineString') {
            geometry.coordinates = addPoints(geometry.coordinates);
        }
    });
}

const app = application.create('#viewport', {

    autoRender: false,

    devicePixelRatio: 1,

    init(app) {

        this._advRenderer = new ClayAdvancedRenderer(app.renderer, app.scene, app.timeline, {
            shadow: true,
            temporalSuperSampling: {
                enable: true,
                dynamic: false
            },
            postEffect: {
                enable: true,
                bloom: {
                    enable: false
                },
                screenSpaceAmbientOcclusion: {
                    enable: true,
                    intensity: 1.1,
                    radius: 5
                },
                FXAA: {
                    enable: true
                }
            }
        });
        this._advRenderer.setShadow({
            kernelSize: 10,
            blurSize: 3
        });

        const camera = app.createCamera([0, 0, 170], [0, 0, 0]);

        this._earthNode = app.createNode();
        this._cloudsNode = app.createNode();

        this._elementsNodes = {};
        this._elementsMaterials = {};

        this._diffuseTex = app.loadTextureSync('./asset/paper-detail.png', {
            anisotropic: 8
        });

        vectorElements.forEach(el => {
            this._elementsNodes[el.type] = app.createNode();
            this._elementsMaterials[el.type] = app.createMaterial({
                diffuseMap: this._diffuseTex,
                uvRepeat: [10, 10],
                color: config[el.type + 'Color'],
                roughness: 1
            });
            this._elementsMaterials[el.type].name = 'mat_' + el.type;
        });

        app.methods.updateEarthSphere();
        app.methods.updateElements();
        app.methods.updateVisibility();
        app.methods.generateCloud();

        app.createAmbientCubemapLight('./asset/Grand_Canyon_C.hdr', 0.2, 0.8, 1).then(result => {
            const skybox = new plugin.Skybox({
                environmentMap: result.specular.cubemap,
                scene: app.scene
            });
            skybox.material.set('lod', 2);
            this._skybox = skybox;
            this._advRenderer.render();
        });
        const light = app.createDirectionalLight([-1, -1, -1], '#fff');
        light.shadowResolution = 1024;
        light.shadowBias = 0.0005;

        this._control = new plugin.OrbitControl({
            target: camera,
            domElement: app.container,
            timeline: app.timeline,
            rotateSensitivity: 2
        });
        this._control.on('update', () => {
            this._advRenderer.render();
        });
        this._advRenderer.render();
    },

    methods: {
        updateEarthSphere(app) {
            this._earthNode.removeAll();

            const earthMat = app.createMaterial({
                roughness: 1,
                color: config.earthColor,
                diffuseMap: this._diffuseTex,
            });
            earthMat.name = 'mat_earth';

            faces.forEach((face, idx) => {
                const planeGeo = new builtinGeometries.Plane({
                    widthSegments: 20,
                    heightSegments: 20
                });
                app.createMesh(planeGeo, earthMat, this._earthNode);
                distortion(
                    planeGeo.attributes.position.value,
                    {x: -1, y: -1, width: 2, height: 2},
                    config.radius,
                    config.curveness,
                    face
                );
                planeGeo.generateVertexNormals();
            });

            this._advRenderer.render();
        },

        updateElements(app) {
            this._id = Math.random();
            const advRenderer = this._advRenderer;
            const elementsNodes = this._elementsNodes;
            const elementsMaterials = this._elementsMaterials;
            for (let key in elementsNodes) {
                elementsNodes[key].removeAll();
            }

            for (let key in this._buildingAnimators) {
                this._buildingAnimators[key].stop();
            }
            const buildingAnimators = this._buildingAnimators = {};

            function createElementMesh(elConfig, features, tile, idx) {
                const extent = tile.extent2d.convertTo(c => map.pointToCoord(c)).toJSON();
                const scale = 1e4;

                if (elConfig.type === 'roads') {
                    subdivideLineFeatures(features, 4e-4);
                }
                // if (elConfig.type === 'water') {
                //     console.log(JSON.stringify({ type: 'FeatureCollection', features: features}));
                // }
                const result = extrudeGeoJSON({features: features}, {
                    translate: [-extent.xmin * scale, -extent.ymin * scale],
                    scale: [scale, scale],
                    lineWidth: 0.5,
                    excludeBottom: true,
                    // bevelSize: elConfig.type === 'buildings' ? 0.2: 0,
                    simplify: elConfig.type === 'buildings' ? 0.01 : 0,
                    depth: elConfig.depth
                });
                const boundingRect = {
                    x: 0, y: 0,
                    width: (extent.xmax - extent.xmin) * scale,
                    height: (extent.ymax - extent.ymin) * scale
                };
                const poly = result[elConfig.geometryType];
                const geo = new Geometry();
                if (elConfig.type === 'water') {
                    const {indices, position} = tessellate(poly.position, poly.indices, 8);
                    poly.indices = indices;
                    poly.position = position;
                }
                geo.attributes.texcoord0.value = poly.uv;
                geo.indices = poly.indices;
                const mesh = app.createMesh(geo, elementsMaterials[elConfig.type], elementsNodes[elConfig.type]);
                if (elConfig.type === 'buildings') {
                    let positionAnimateFrom = new Float32Array(poly.position);
                    for (let i = 0; i < positionAnimateFrom.length; i += 3) {
                        const z = positionAnimateFrom[i + 2];
                        if (z > 0) {
                            positionAnimateFrom[i + 2] = 1;
                        }
                    }

                    let positionAnimateTo = distortion(
                        poly.position, boundingRect, config.radius, config.curveness, faces[idx]
                    );
                    positionAnimateFrom = distortion(
                        positionAnimateFrom, boundingRect, config.radius, config.curveness, faces[idx]
                    );
                    geo.attributes.position.value = positionAnimateTo;
                    geo.generateVertexNormals();
                    geo.updateBoundingBox();

                    const transitionPosition = new Float32Array(positionAnimateFrom);
                    geo.attributes.position.value = transitionPosition;

                    mesh.invisible = true;
                    const obj = {
                        p: 0
                    };
                    buildingAnimators[faces[idx]] = app.timeline.animate(obj)
                        .when(2000, {
                            p: 1
                        })
                        .delay(1000)
                        .during((obj, p) => {
                            mesh.invisible = false;
                            for (let i = 0; i < transitionPosition.length; i++) {
                                const a = positionAnimateFrom[i];
                                const b = positionAnimateTo[i];
                                transitionPosition[i] = (b - a) * p + a;
                            }
                            geo.dirty();
                            advRenderer.render();
                        })
                        .start('elasticOut');
                }
                else {
                    geo.attributes.position.value = distortion(
                        poly.position, boundingRect,
                        config.radius, config.curveness, faces[idx]
                    );
                    geo.generateVertexNormals();
                    geo.updateBoundingBox();
                }
            }

            const tiles = mainLayer.getTiles();
            const subdomains = ['a', 'b', 'c'];
            tiles.tileGrids[0].tiles.forEach((tile, idx) => {
                const fetchId = this._id;
                if (idx >= 6) {
                    return;
                }

                const url = mvtUrlTpl.replace('{z}', tile.z)
                    .replace('{x}', tile.x)
                    .replace('{y}', tile.y)
                    .replace('{s}', subdomains[idx % 3]);

                if (mvtCache.get(url)) {
                    const features = mvtCache.get(url);
                    for (let key in features) {
                        createElementMesh(
                            vectorElements.find(config => config.type === key),
                            features[key],
                            tile, idx
                        );
                    }
                }

                return fetch(url, {
                    mode: 'cors'
                }).then(response => response.arrayBuffer())
                    .then(buffer => {
                        if (fetchId !== this._id) {
                            return;
                        }

                        const pbf = new Protobuf(new Uint8Array(buffer));
                        const vTile = new VectorTile(pbf);
                        if (!vTile.layers.buildings) {
                            return;
                        }

                        const features = {};
                        ['buildings', 'roads', 'water'].forEach(type => {
                            if (!vTile.layers[type]) {
                                return;
                            }
                            features[type] = [];
                            for (let i = 0; i < vTile.layers[type].length; i++) {
                                const feature = vTile.layers[type].feature(i).toGeoJSON(tile.x, tile.y, tile.z);
                                features[type].push(feature);
                            }
                        });


                        mvtCache.set(url, features);
                        for (let key in features) {
                            createElementMesh(
                                vectorElements.find(config => config.type === key),
                                features[key],
                                tile, idx
                            );
                        }

                        app.methods.render();
                    });
            });
        },

        generateCloud(app) {
            const cloudNumber = 15;
            const pointCount = 100;
            this._cloudsNode.removeAll();

            const cloudMaterial = app.createMaterial({
                roughness: 1
            });
            cloudMaterial.name = 'mat_cloud';

            function randomInSphere(r) {
                const alpha = Math.random() * Math.PI * 2;
                const beta = Math.random() * Math.PI;

                const r2 = Math.sin(beta) * r;
                const y = Math.cos(beta) * r;
                const x = Math.cos(alpha) * r2;
                const z = Math.sin(alpha) * r2;
                return [x, y, z];
            }
            for (let i = 0; i < cloudNumber; i++) {
                const positionArr = new Float32Array(5 * pointCount * 3);
                let off = 0;
                let indices = [];

                let dx = Math.random() - 0.5;
                let dy = Math.random() - 0.5;
                const len = Math.sqrt(dx * dx + dy * dy);
                dx /= len; dy /= len;

                const dist = 4 + Math.random() * 2;

                for (let i = 0; i < 5; i++) {
                    const posOff = (i - 2) + (Math.random() * 0.4 - 0.2);
                    const rBase = 3 - Math.abs(posOff);
                    const points = [];
                    const vertexOffset = off / 3;
                    for (let i = 0; i < pointCount; i++) {
                        const r = Math.random() * rBase + rBase;
                        const pt = randomInSphere(r);
                        points.push(pt);
                        positionArr[off++] = pt[0] + posOff * dist * dx;
                        positionArr[off++] = pt[1] + posOff * dist * dy;
                        positionArr[off++] = pt[2];
                    }
                    const tmp = quickhull(points);
                    for (let m = 0; m < tmp.length; m++) {
                        indices.push(tmp[m][0] + vertexOffset);
                        indices.push(tmp[m][1] + vertexOffset);
                        indices.push(tmp[m][2] + vertexOffset);
                    }
                }

                const geo = new Geometry();
                geo.attributes.position.value = positionArr;
                geo.initIndicesFromArray(indices);
                geo.generateFaceNormals();

                const mesh = app.createMesh(geo, cloudMaterial, this._cloudsNode);
                mesh.position.setArray(randomInSphere(config.radius / Math.sqrt(2) + 20 + Math.random() * 10));
                mesh.lookAt(Vector3.ZERO);
            }
            app.methods.render();
        },

        updateColor() {
            this._earthNode.eachChild(mesh => {
                mesh.material.set('color', config.earthColor);
            });
            this._cloudsNode.eachChild(mesh => {
                mesh.material.set('color', config.cloudColor);
            });
            for (let key in this._elementsMaterials) {
                this._elementsMaterials[key].set('color', config[key + 'Color']);
            }
            this._advRenderer.render();
        },

        render(app) {
            this._advRenderer.render();
            setTimeout(() => {
                this._advRenderer.render();
            }, 20);
        },

        updateAutoRotate() {
            this._control.autoRotateSpeed = config.autoRotateSpeed * 50;
            this._control.autoRotate = Math.abs(config.autoRotateSpeed) > 0.3;
        },

        updateSky(app) {
            config.sky ? this._skybox.attachScene(app.scene) : this._skybox.detachScene();
            this._advRenderer.render();
        },

        updateVisibility(app) {
            this._earthNode.invisible = !config.showEarth;
            this._cloudsNode.invisible = !config.showCloud;

            this._elementsNodes.buildings.invisible = !config.showBuildings;
            this._elementsNodes.roads.invisible = !config.showRoads;
            this._elementsNodes.water.invisible = !config.showWater;

            app.methods.render();
        }
    }
});

function updateAll() {
    app.methods.updateEarthSphere();
    app.methods.updateElements();
}

let timeout;
map.on('moveend', function () {
    clearTimeout(timeout);
    timeout = setTimeout(function () {
        app.methods.updateElements();
    }, 500);
});
map.on('zoomend', function () {
    clearTimeout(timeout);
    timeout = setTimeout(function () {
        app.methods.updateElements();
    }, 500);
});

const ui = new dat.GUI();
ui.add(config, 'radius', 30, 100).step(1).onChange(updateAll);
ui.add(config, 'autoRotateSpeed', -2, 2).step(0.01).onChange(app.methods.updateAutoRotate);
ui.add(config, 'sky').onChange(app.methods.updateSky);

const earthFolder = ui.addFolder('Earth');
earthFolder.add(config, 'showEarth').onChange(app.methods.updateVisibility);
earthFolder.addColor(config, 'earthColor').onChange(app.methods.updateColor);

const buildingsFolder = ui.addFolder('Buildings');
buildingsFolder.add(config, 'showBuildings').onChange(app.methods.updateVisibility);
buildingsFolder.addColor(config, 'buildingsColor').onChange(app.methods.updateColor);

const roadsFolder = ui.addFolder('Roads');
roadsFolder.add(config, 'showRoads').onChange(app.methods.updateVisibility);
roadsFolder.addColor(config, 'roadsColor').onChange(app.methods.updateColor);

const waterFolder = ui.addFolder('Water');
waterFolder.add(config, 'showWater').onChange(app.methods.updateVisibility);
waterFolder.addColor(config, 'waterColor').onChange(app.methods.updateColor);

const cloudFolder = ui.addFolder('Cloud');
cloudFolder.add(config, 'showCloud').onChange(app.methods.updateVisibility);
cloudFolder.addColor(config, 'cloudColor').onChange(app.methods.updateColor);
cloudFolder.add(config, 'randomCloud');

ui.add(config, 'downloadOBJ');

window.addEventListener('resize', () => { app.resize(); app.methods.render(); });