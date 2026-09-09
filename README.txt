VEYRON NETWORKS PORTAL 2.0

Features
- Customer login through Xceednet
- Live Xceednet package list
- Admin package selling-price controls
- Admin subscriber search and package change/renew
- Admin reset MAC
- Cashfree order creation and checkout
- Cashfree webhook signature verification
- Successful payment -> Xceednet payment -> Xceednet invoice -> package change/renew
- Admin Payments and Invoices pages
- Payment Gateway page styled like the supplied Xceednet Location Settings screen
- Company/GST and invoice settings

SETUP
1. Copy .env.example to .env.
2. Put your existing Xceednet admin auth token in XCEEDNET_ADMIN_AUTH. Do not paste it into chat or expose it in browser code.
3. Set ADMIN_EMAIL and ADMIN_PASSWORD.
4. Set PUBLIC_BASE_URL to the HTTPS URL where this portal is publicly reachable. Cashfree production webhooks require HTTPS.
5. Run:
   npm install
   npm start
6. Open http://127.0.0.1:3000

CASHFREE
In Admin -> Payment Gateway select Cashfree, enter Client/App ID and Secret Key, set Sandbox or Production, enable the gateway and save. Set the Cashfree webhook endpoint to:
   https://YOUR-DOMAIN/api/payments/cashfree/webhook
Use the webhook secret in the portal. Test in sandbox before production.

IMPORTANT
The backend only changes an Xceednet package after the payment is verified by Cashfree. It does not trust a browser success message.
