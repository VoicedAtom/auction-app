# JIDO Engineering Auction server

A live, multi-hall auction. Teams bid on their phones or laptops, everyone in a hall sees every bid
as it happens, and the server runs the clock, checks every bid and settles every slot.

## Run it

You need Node.js 18 or newer. There is nothing to install.

    node server.js

- Teams open:      http://YOUR-SERVER:3000/
- Organiser opens: http://YOUR-SERVER:3000/organiser   (locked with the organiser key)

Teams and organisers must be able to reach the server on the same address. On a local network
use the server computer's IP address, for example http://192.168.1.20:3000/.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| PORT | 3000 | Port to listen on |
| ORGANISER_KEY | JCkPwM | Key for the organiser console. Change it before the event. |
| BUDGET | 10000 | Starting JC for every team |
| HALLS | 5 | Number of halls |
| HALL_CAPACITY | 10 | Teams per hall. When a hall is full, the next team is told to move to the next hall. |
| PER_SLOT | 6 | Components opened together in one slot |
| ROUND_SEC | 90 | Length of a slot |
| GAP_SEC | 5 | Pause between slots |
| SNIPE_SEC | 10 | A bid in the last N seconds adds N seconds |
| MAX_EXTENSIONS | 3 | Most extensions per slot |
| MIN_INCREMENT | 2 | Smallest raise over your own last bid |
| DATA_DIR | ./data | Where state.json is saved |

Example: `ORGANISER_KEY=MyNewKey HALLS=3 HALL_CAPACITY=12 node server.js`
(On Windows PowerShell: `$env:ORGANISER_KEY="MyNewKey"; node server.js`)

## How the auction runs

1. Teams enter a team name and are placed in the first hall with a free seat.
2. Each team picks and locks a problem statement, then enters the auction room.
3. The organiser presses **Start auction**. The server then opens each slot, runs the clock,
   settles the winners and opens the next slot by itself. The organiser page can be closed.
4. The shop (basic items at a fixed price) is open the whole time.
5. Results and standings are on the organiser Results page, and as a CSV download.

The component list is `items.json`:
`[category, name, lot size, lots available per hall, starting bid]`.
Items in the Wiring & Basics category, and items starting at 3 JC or less, go to the shop. The rest are auctioned.

## Safety and limits

- The server checks everything: bid size, balance, timing, hall, stock. A modified page cannot cheat.
- The organiser key is checked on the server, with a limit on wrong tries. Use HTTPS in production, because
  the key and team tokens travel with each request.
- State is saved to `data/state.json` after each change and reloaded on restart, so a restart in the middle
  of the auction keeps everything.
- All state is kept in one process in memory. Run exactly one copy of the server. This is fine for a few
  hundred teams.
- A team is recognised by a private token stored in its browser. A team that clears its browser data cannot
  rejoin under the same name until you press **Reset auction** on the organiser page.
- Press **Reset auction** before the real event to clear any test data.

## Put it online

Teams only need a normal web address. The server must stay running for the whole event, so do not
use a host that puts the site to sleep. You also need a place to keep the `data` folder, otherwise a
restart wipes the auction.

### Option A: Render (no server skills needed)
1. Create a free GitHub account and upload this folder as a new repository.
2. On render.com choose New, then Blueprint, and pick that repository. It reads `render.yaml`.
3. When it asks for ORGANISER_KEY, type your own secret key.
4. Wait for the deploy. Render gives you an address like https://jido-auction.onrender.com.
   Teams open that address. You open the same address followed by /organiser.
5. Optional: add your own domain in the Render settings.
Note: `render.yaml` uses a paid plan, because a free plan sleeps when idle and has no disk. Check
Render's current plans and prices before you choose.

### Option B: your own server (a cheap VPS or a college server)
1. Install Node.js 18 or newer and Caddy (it gets the HTTPS certificate by itself).
2. Copy this folder to the server and start it so it survives restarts, for example with pm2:

       npm install -g pm2
       ORGANISER_KEY=YourSecretKey TRUST_PROXY=1 pm2 start server.js --name jido
       pm2 save && pm2 startup

3. Point a domain name at the server, then create a Caddyfile:

       auction.yourdomain.com {
         reverse_proxy localhost:3000 {
           flush_interval -1
         }
       }

4. Teams open https://auction.yourdomain.com and you open https://auction.yourdomain.com/organiser.

### Option C: same Wi-Fi only (no internet)
Run `node server.js` on one laptop, find its IP address, and have everyone on the same Wi-Fi open
http://THAT-IP:3000. This is the simplest and most reliable choice if everyone is in one building.

### Before the event
- Set your own ORGANISER_KEY. Open /healthz to check the server is up.
- Do a rehearsal with a few phones and a laptop, then press **Reset auction** on the organiser page.
- Keep TRUST_PROXY=1 when hosted behind Render or Caddy, so the wrong-key limit counts each person separately.

## Test

Project files: `server.js`, `items.json`, `public/index.html` (teams), `public/organiser.html` (organiser), plus `Dockerfile` and `render.yaml` for hosting.
