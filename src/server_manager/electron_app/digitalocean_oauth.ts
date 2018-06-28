// Copyright 2018 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as bodyParser from 'body-parser';
import * as crypto from 'crypto';
import * as electron from 'electron';
import * as express from 'express';
import * as http from 'http';
import * as path from 'path';


const CLIENT_ID = '7f84935771d49c2331e1cfb60c7827e20eaf128103435d82ad20b3c53253b721';
const REDIRECT_URI = 'http://localhost:55189/';

const REGISTERED_REDIRECTS = [
  {clientId: '7f84935771d49c2331e1cfb60c7827e20eaf128103435d82ad20b3c53253b721', port: 55189},
  {clientId: '4af51205e8d0d8f4a5b84a6b5ca9ea7124f914a5621b6a731ce433c2c7db533b', port: 60434},
  {clientId: '706928a1c91cbd646c4e0d744c8cbdfbf555a944b821ac7812a7314a4649683a', port: 61437}
];

function randomValueHex(len: number): string {
  return crypto.randomBytes(Math.ceil(len / 2))
      .toString('hex')  // convert to hexadecimal format
      .slice(0, len);   // return required number of characters
}

interface ServerError extends Error {
  code: string;
}

// Makes server listen on each of the listed ports until there's one open.
// Returns the index of the port used.
function listenOnFirstPort(server: http.Server, portList: number[]): Promise<number> {
  let portIdx = 0;
  return new Promise((resolve, reject) => {
    server.once('listening', () => {
      console.log(`Listening on port ${portList[portIdx]}`);
      resolve(portIdx);
    });
    server.on('error', (error: ServerError) => {
      if (error.code === 'EADDRINUSE') {
        console.log(`Port ${portList[portIdx]} already in use`);
        portIdx += 1;
        if (portIdx < portList.length) {
          const port = portList[portIdx];
          console.log(`Trying port ${port}`);
          server.listen({host: 'localhost', port, exclusive: true});
          return;
        }
      }
      server.close();
      reject(error);
    });
    server.listen({host: 'localhost', port: portList[portIdx], exclusive: true});
  });
}


export interface OauthSession {
  result: Promise<string>;
  isCancelled(): boolean;
  cancel(): void;
}

// Runs the DigitalOcean oauth flow and returns the access token.
// See https://developers.digitalocean.com/documentation/oauth/ for the API.
export function runOauth(): OauthSession {
  const secret = randomValueHex(16);

  const app = express();
  const server = http.createServer(app);
  server.on('close', () => console.log('Oauth server closed'));

  let isCancelled = false;
  app.use((req, res, next) => {
    if (isCancelled) {
      res.status(503).send('Authentication cancelled');
    } else {
      next();
    }
  });

  app.get('/', (request, response) => {
    response.send(`<html>
          <head><title>Authenticating...</title></head>
          <body>
              <form id="form" method="POST">
                  <input id="params" type="hidden" name="params"></input>
              </form>
              <script>
                  let params = new URLSearchParams(location.hash.substr(1));
                  let form = document.getElementById("form");
                  let targetUrl = params.get("state");
                  form.setAttribute("action", targetUrl);
                  document.getElementById("params").setAttribute("value", params);
                  form.submit();
              </script>
          </body>
      </html>`);
  });

  const rejectWrapper = {reject: (error: Error) => {}};
  const result = new Promise<string>((resolve, reject) => {
    rejectWrapper.reject = reject;
    app.post('/', bodyParser.urlencoded({type: '*/*', extended: false}), (request, response) => {
      server.close();

      const requestSecret = request.query.secret;
      if (requestSecret !== secret) {
        response.status(400).send('Authentication failed');
        reject(new Error(`Expected secret ${secret}. Got ${requestSecret}`));
        return;
      }
      const params = new URLSearchParams(request.body.params);
      if (params.get('error')) {
        response.status(400).send('Authentication failed');
        reject(new Error(`DigitalOcean OAuth error: ${params.get('error_description')}`));
        return;
      }
      const accessToken = params.get('access_token');
      if (accessToken) {
        // TODO: Query account info and redirect to https://cloud.digitalocean.com is not active.
        response.send('Authentication successful');
        resolve(accessToken);
      } else {
        response.status(400).send('Authentication failed');
        reject(new Error('No access_token on OAuth response'));
      }
    });

    listenOnFirstPort(server, REGISTERED_REDIRECTS.map(e => e.port)).then((index) => {
      const port = REGISTERED_REDIRECTS[index].port;
      const clientId = REGISTERED_REDIRECTS[index].clientId;
      const address = server.address();
      console.log(`OAuth target listening on ${address.address}:${address.port}`);

      const targetUrl = `http://localhost:${encodeURIComponent(address.port.toString())}?secret=${
          encodeURIComponent(secret)}`;
      const oauthUrl = `https://cloud.digitalocean.com/v1/oauth/authorize?client_id=${
          encodeURIComponent(
              clientId)}&response_type=token&scope=read%20write&redirect_uri=http://localhost:${
          encodeURIComponent(port.toString())}/&state=${encodeURIComponent(targetUrl)}`;
      console.log(`Opening OAuth URL ${oauthUrl}`);
      electron.shell.openExternal(oauthUrl);
    });
  });
  return {
    result,
    isCancelled() {
      return isCancelled;
    },
    cancel() {
      console.log('Session cancelled');
      isCancelled = true;
      server.close();
      rejectWrapper.reject(new Error('Authentication cancelled'));
    }
  };
}