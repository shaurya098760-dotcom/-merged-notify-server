# Merged Notify Server

Ye ek hi server hai jisme 5 alag Render services ka poora logic hai:

1. `zap-webhook` — ZapUPI payment webhook (deposit credit)
2. `arenax-notify-server` — deposit/withdraw/result/room notifications + admin broadcast
3. `refer-system` — referral code apply
4. `shubh-sankalp-notify-server` — leads → push notification
5. `atc-notify-server` — inquiries → push notification

Fayda: pehle 5 services milkar 750-hour/month free quota jaldi khatam kar
deti thi (5 × 24×30 hrs ki demand). Ab sirf EK service chalti hai, jo
poora mahina 24/7 chalne par bhi ~744 hours use karti hai — 750 ke
andar aasani se fit ho jaati hai.

## Deploy Steps (Render)

1. Ye poora folder ek naye GitHub repo me push karo (jaise `merged-notify-server`).
2. https://render.com → **New +** → **Web Service** → apna naya repo connect karo.
3. Settings:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: **Free**
4. **Environment** tab me 4 variables add karo (dekho `.env.example`):
   - `FIREX_SERVICE_ACCOUNT`
   - `SHUBH_SERVICE_ACCOUNT`
   - `ATC_SERVICE_ACCOUNT`
   - `ADMIN_API_KEY`
5. Deploy hone do (2-3 min). Tumhe naya URL milega, jaise:
   `https://merged-notify-server.onrender.com`

## Deploy hone ke baad — ye jagah URLs update karni hain

### 1. Admin panel (`script.js`, line ~21)
```js
// PEHLE:
const NOTIFY_SERVER_URL = "https://arenax-notify-server.onrender.com";

// AB:
const NOTIFY_SERVER_URL = "https://merged-notify-server.onrender.com";
```
(`/send-broadcast` route same hi hai, sirf domain change hoga)

### 2. Flutter app (`main.dart`, `setupReferralForNewUser()` function)
```dart
// PEHLE:
Uri.parse('https://refer-system.onrender.com/apply-referral'),

// AB:
Uri.parse('https://merged-notify-server.onrender.com/refer/apply-referral'),
```
⚠️ Route path bhi change hua hai: `/apply-referral` → `/refer/apply-referral`

### 3. ZapUPI payment gateway webhook URL
Ye Firestore ke `settings/payment` document ke `webhookUrl` field me store
hoti hai (admin panel ki Payment Settings se set hoti hai) — **koi code
change nahi chahiye**, bas admin panel me jaake purana URL naye se replace
kar do:
```
Purana: https://zap-webhook.onrender.com/webhook/zapupi
Naya:   https://merged-notify-server.onrender.com/webhook/zapupi
```

### 4. Uptime Robot
Ab sirf EK monitor chahiye:
```
https://merged-notify-server.onrender.com/
```
Baaki 4 purane monitors (refer-system, zap-webhook, arenax-notify-server,
atc-notify-server, shubh-sankalp-notify-server) delete/pause kar do —
warna wo bhi purani suspended services ko baar baar wake karne ki koshish
karte rahenge (jo suspended hone ki wajah se fail hi hongi, koi nuksaan
nahi, lekin unnecessary hai).

## Purani 5 services ka kya karein?

Naya server deploy + test ho jaane ke baad, Render dashboard se purani
5 services **delete** kar dena best hai:
- Workspace clean rahega
- Free-tier quota sirf isi ek naye service ke liye reserve rahega
- Koi confusion nahi rahega ki kaunsi service abhi bhi use ho rahi hai

## Testing checklist deploy ke baad

- [ ] Naye URL ko browser me kholo → "Merged backend ... is running ✅" dikhna chahiye
- [ ] Admin panel se "Send to All Users" test karo
- [ ] Ek test deposit/withdraw approve/reject karke notification check karo
- [ ] Naye user ko referral code se signup karwa ke check karo dono ko reward mila
- [ ] Render **Logs** tab me dekho koi Firestore listener error to nahi aa raha
