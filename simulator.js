
require('dotenv').config()
const cloudant = require('cloudant')
const route1 = require('./route.json')
const route2 = require('./rute2.json')


let config = {
  LAPS: process.env['simulator_number_of_runs'] || 1,
  INTERVAL: process.env['simulator_event_interval'] || 500,
  STOPTIME: process.env['simulator_stop_duration'] || 25000000000,
  TARGET_CLOUDANT: process.env['simulator_target_cloudant'] || 'http://127.0.0.1:5984/kotugo_bk'
}


var db = null;


// Interpolate between two coordinates
function interpolateCoords(coord1, coord2, t) {
  return [
    coord1[0] + (coord2[0] - coord1[0]) * t,
    coord1[1] + (coord2[1] - coord1[1]) * t
  ];
}

const SMOOTH_STEPS = 10; // Number of interpolation steps between points
const SMOOTH_INTERVAL = 100; // ms between smooth steps

const simulateCar = (routeJson, carId, step, numRuns) => {
  if (step >= routeJson.features.length) {
    step = 0;
    numRuns++;
    if (numRuns >= config.LAPS) {
      console.log(`Car ${carId} finished all laps.`);
      return;
    } else {
      console.log(`Car ${carId} starting new lap...`);
    }
  }

  let currentFeature = routeJson.features[step];
  let nextFeature = routeJson.features[(step + 1) % routeJson.features.length];
  let isStop = currentFeature.properties.is_stop;

  // Interpolate between current and next point
  let smoothMove = (smoothStep) => {
    let t = smoothStep / SMOOTH_STEPS;
    let coords = interpolateCoords(currentFeature.geometry.coordinates, nextFeature.geometry.coordinates, t);
    let geoPosition = JSON.parse(JSON.stringify(currentFeature));
    geoPosition.geometry.coordinates = coords;
    geoPosition.properties.car_id = carId;
    insertCloudant(geoPosition)
      .then(() => sleepTimer(SMOOTH_INTERVAL))
      .then(() => {
        if (smoothStep < SMOOTH_STEPS) {
          smoothMove(smoothStep + 1);
        } else {
          // If stop, wait longer at the stop
          sleepTimer(isStop ? config.STOPTIME : config.INTERVAL)
            .then(() => simulateCar(routeJson, carId, step + 1, numRuns));
        }
      });
  };
  smoothMove(0);
}

const insertCloudant = (msg) => {
  return Promise.resolve()
    .then(() => {
      if (!db) {
        console.error('Cloudant DB is not initialized. Skipping insert.');
        return Promise.reject(new Error('Cloudant DB is not initialized.'));
      }
      return new Promise((resolve, reject) => {
        db.insert(msg, (err, body) => {
          if (err) {
            console.error(err)
            reject(err)
          } else {
            console.log(`Inserted position for car ${msg.properties.car_id}: ${msg.geometry.coordinates}`)
            // After insert, delete previous docs for this car
            db.list({include_docs: true}, (err, result) => {
              if (err) {
                console.error('Error listing docs:', err);
                resolve();
                return;
              }
              const docsToDelete = result.rows
                .filter(row => row.doc && row.doc.properties && row.doc.properties.car_id === msg.properties.car_id && row.doc._id !== body.id)
                .map(row => ({
                  _id: row.doc._id,
                  _rev: row.doc._rev,
                  _deleted: true
                }));
              if (docsToDelete.length > 0) {
                db.bulk({docs: docsToDelete}, (err2, res2) => {
                  if (err2) {
                    console.error('Error deleting docs:', err2);
                  } else {
                    console.log(`Deleted previous docs for car ${msg.properties.car_id}:`, docsToDelete.length);
                  }
                  resolve();
                });
              } else {
                resolve();
              }
            });
          }
        })
      })
    })
    .catch(err => {
      console.error(err)
      return Promise.reject(err)
    })
}

const initCloudant = () => {
  return Promise.resolve()
    .then(() => {
      return new Promise((resolve, reject) => {
        let cloudantindex = config.TARGET_CLOUDANT.lastIndexOf('/')
        let hostcloudant = config.TARGET_CLOUDANT.substring(0, cloudantindex)
        let dbnamecloudant = config.TARGET_CLOUDANT.substring(cloudantindex + 1)
        console.log(`trying to access db at ${hostcloudant}/${dbnamecloudant}`)
        let c;
        try {
          c = cloudant(hostcloudant);
        } catch (err) {
          console.error('Cloudant initialization failed:', err);
          db = null;
          resolve(false);
          return;
        }
        c.db.get(dbnamecloudant, (err, body) => {
          if (err) {
            console.error('Failed to access database:', err);
            db = null;
            resolve(false);
          } else {
            console.log(`accessed db at ${hostcloudant}/${dbnamecloudant}`)
            console.log(body)
            db = c.db.use(dbnamecloudant)
            resolve(true)
          }
        })
      })
    })
    .catch(err => {
      console.error('Cloudant initialization error:', err);
      db = null;
      return Promise.resolve(false);
    })
}


const sleepTimer = (ms) => {
  return new Promise((resolve, reject) => setTimeout(resolve, ms))
}

initCloudant().then(() => {
  simulateCar(route1, 1, 0, 0);
  simulateCar(route2, 2, 0, 0);
});
