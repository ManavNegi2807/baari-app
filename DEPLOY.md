# Putting Baari on a server

Goal: patients, clinics and the Baari team each use their own web address, from anywhere, and nobody can open the others' pages.

| Who | Address | What it opens |
|---|---|---|
| Patients | book.yourdomain.com | booking pages only |
| Clinics | app.yourdomain.com | clinic login and clinic desk. Each login sees only its own clinic |
| Baari team | admin.yourdomain.com | company site, behind an extra gate (step 5) |

Each address answers only its own pages. Anything else returns "not found". Cookies are separate per address, so a clinic login never works on the company site.

## 1. Get a small server
Any small Linux server with a disk that keeps its files (a VPS from DigitalOcean, Hetzner, AWS Lightsail and similar). Baari stores everything in one file, so use a service whose disk is permanent. Many "free tier" web hosts wipe the disk on every restart and would erase your data.
You need Node 22.5 or newer (Node 24 is best).

## 2. Point three names at the server
In your domain's DNS, add three records (type A) for book, app and admin, all pointing to the server's IP address.

## 3. Copy the app and set it up
Copy the baari-app folder to the server (without node_modules), then:

    cd baari-app
    npm install

Create the file `.env` in that folder:

    PORT=5000
    TRUST_PROXY=true
    PATIENT_HOST=book.yourdomain.com
    STAFF_HOST=app.yourdomain.com
    COMPANY_HOST=admin.yourdomain.com
    DATABASE_PATH=/var/lib/baari/baari.db
    COMPANY_PASSWORD=choose-a-long-password
    STAFF_PASSWORD=another-long-password

Create the data folder once: `sudo mkdir -p /var/lib/baari && sudo chown $USER /var/lib/baari`.
Keep it running with pm2: `npm i -g pm2`, then `pm2 start src/server.js --name baari`, `pm2 save`, `pm2 startup`.

## 4. Turn on https
Install Caddy (caddyserver.com). Put this in `/etc/caddy/Caddyfile`, then run `sudo systemctl reload caddy`:

    book.yourdomain.com, app.yourdomain.com, admin.yourdomain.com {
        reverse_proxy localhost:5000
    }

Caddy gets and renews the https certificates for you. Open port 80 and 443 on the server and keep port 5000 closed to the outside.

## 5. Lock the company address to your team
Passwords alone are not enough for the company site. Put it behind Cloudflare Access (free for small teams): move your domain's DNS to Cloudflare, then in Zero Trust add an Access application for admin.yourdomain.com that allows only your team's email addresses. Only after that sign-in does the Baari company login even appear. A VPN such as Tailscale works too.

## 6. First login and clinics
1. Open admin.yourdomain.com, log in as `admin` with your COMPANY_PASSWORD, and change it under Settings and team.
2. Clinics tab, "Add clinic". This creates the clinic and the owner login. Send the owner their username, password and the address app.yourdomain.com.
3. The older shared `staff` login can see every clinic. Once clinics have their own logins, remove it from the database or change its password and keep it for yourselves.
4. WhatsApp webhook address (if used): https://book.yourdomain.com/webhook

## Online payment for the priority plan (optional)

Patients can pay for a clinic's priority plan with UPI or card on the booking page. Without this, the clinic marks patients as paid at the desk and everything else works the same.

1. Create a Razorpay account and finish its business verification. Start with the test keys.
2. In `.env`, set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`, then restart. The start-up lines say "Razorpay: keys found".
3. In the Razorpay dashboard open Webhooks. Add `https://YOUR-PATIENT-SITE/api/patient/pay/webhook`, tick `payment.captured`, set a secret, and put the same secret in `RAZORPAY_WEBHOOK_SECRET`. This catches patients who close the page right after paying.
4. Pay with a test card or UPI test ID and check that the patient becomes a member (Appointments tab, Priority members list, marked "paid online").
5. Swap in the live keys when you are ready.

All online payments land in your one Razorpay account. Passing each clinic its share is a separate step: do it by hand from the Priority members list, or ask for Razorpay Route to be added. Refunds are done in the Razorpay dashboard, then use Cancel on the member in the desk.

## Backups
Copy the file at DATABASE_PATH somewhere safe every day. It holds all clinics, patients and bookings.
