require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// FIREBASE ADMIN INIT — 3 ALAG PROJECTS, 3 ALAG NAMED APPS
//
// FireXBattle app (zap-webhook + arenax-notify-server + refer-system)
// teeno hi isi ek Firebase project ko use karte the, isliye ek hi
// service account se teeno chal jaate hain.
//
// Shubh Sankalp aur ATC — inke apne apne alag Firebase projects hain,
// isliye inke liye alag service accounts / alag named apps chahiye.
// ============================================================

const firexServiceAccount = JSON.parse(process.env.FIREX_SERVICE_ACCOUNT || "{}");
const shubhServiceAccount = JSON.parse(process.env.SHUBH_SERVICE_ACCOUNT || "{}");
const atcServiceAccount = JSON.parse(process.env.ATC_SERVICE_ACCOUNT || "{}");

const firexApp = admin.initializeApp(
  { credential: admin.credential.cert(firexServiceAccount) },
  "firex"
);
const shubhApp = admin.initializeApp(
  { credential: admin.credential.cert(shubhServiceAccount) },
  "shubh"
);
const atcApp = admin.initializeApp(
  { credential: admin.credential.cert(atcServiceAccount) },
  "atc"
);

const firexDb = firexApp.firestore();
const shubhDb = shubhApp.firestore();
const atcDb = atcApp.firestore();

const FieldValue = admin.firestore.FieldValue;

// ============================================================
// ROOT / HEALTH CHECK — Uptime Robot isi EK route ko ping karega
// (ab 5 alag services ki jagah sirf ek hi URL ping karna hai)
// ============================================================
app.get("/", (req, res) => {
  res.send("Merged backend (FireXBattle + Shubh Sankalp + ATC) is running ✅");
});
app.get("/health", (req, res) => res.send("ok"));
app.get("/ping", (req, res) => res.send("pong"));

// ============================================================
// PART 1: ZAP-WEBHOOK (payment gateway → deposit credit)
// ============================================================
function computeDepositCredit(paidAmount, offerData) {
  const amt = Number(paidAmount) || 0;
  const offer = offerData || {};
  if (!offer.enabled) return { creditAmount: amt, bonusAmount: 0 };

  const tiers = Array.isArray(offer.tiers) ? offer.tiers : [];
  const tier = tiers.find((t) => Math.abs(Number(t.pay) - amt) < 0.005);
  if (!tier) return { creditAmount: amt, bonusAmount: 0 };

  const creditAmount = Number(tier.credit);
  return { creditAmount, bonusAmount: creditAmount - amt };
}

app.post("/webhook/zapupi", async (req, res) => {
  try {
    const data = req.body || {};
    console.log("[zap-webhook] Webhook body:", JSON.stringify(data));

    const orderId = data.order_id || data.orderId || data.txn_id || "";
    const status = (data.status || data.payment_status || "").toString().toLowerCase();
    const amount = parseFloat(data.amount || data.pay_amount || data.txn_amount || 0);
    const txnId = data.txn_id || data.txnId || data.transaction_id || "";
    const utr = data.utr || data.UTR || "";

    if (!orderId) {
      return res.status(200).json({ status: "ok", msg: "no order_id" });
    }

    if (status !== "success" && status !== "completed" && status !== "paid") {
      console.log("[zap-webhook] Not success:", status);
      return res.status(200).json({ status: "ok" });
    }

    const orderRef = firexDb.collection("payment_orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      console.log("[zap-webhook] Order not found:", orderId);
      return res.status(200).json({ status: "ok", msg: "order not found" });
    }

    const orderData = orderSnap.data();
    if (orderData.status === "success") {
      return res.status(200).json({ status: "ok", msg: "already credited" });
    }

    const uid = orderData.uid;
    if (!uid) {
      return res.status(200).json({ status: "ok", msg: "no uid" });
    }

    const paidAmount = amount || orderData.amount || 0;
    if (paidAmount <= 0) {
      return res.status(200).json({ status: "ok", msg: "invalid amount" });
    }

    const userRef = firexDb.collection("users").doc(uid);
    const offerRef = firexDb.collection("settings").doc("deposit_offer");

    await firexDb.runTransaction(async (tx) => {
      const offerSnap = await tx.get(offerRef);
      const offerData = offerSnap.exists ? offerSnap.data() : {};
      const { creditAmount, bonusAmount } = computeDepositCredit(paidAmount, offerData);

      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) return;

      const userData = userSnap.data();
      const newWallet = (userData.walletPoints || 0) + creditAmount;
      const newJoin = (userData.joinPoints || 0) + creditAmount;

      tx.update(userRef, {
        walletPoints: newWallet,
        joinPoints: newJoin,
      });

      tx.set(
        orderRef,
        {
          status: "success",
          creditedAt: FieldValue.serverTimestamp(),
          txn_id: txnId,
          utr: utr,
          amount: paidAmount,
          creditedAmount: creditAmount,
          bonusAmount: bonusAmount,
        },
        { merge: true }
      );

      tx.set(userRef.collection("wallet_history").doc(), {
        type: "credit",
        title:
          bonusAmount > 0
            ? `Deposit via Payment Gateway (+ Offer Bonus ${bonusAmount.toFixed(2)})`
            : "Deposit via Payment Gateway",
        amount: creditAmount,
        balance_after: newWallet,
        date: FieldValue.serverTimestamp(),
        orderId: orderId,
      });

      const depRef = firexDb.collection("deposit_requests").doc();
      tx.set(depRef, {
        uid: uid,
        amount: paidAmount,
        creditedAmount: creditAmount,
        bonusAmount: bonusAmount,
        utr: utr || txnId || orderId,
        accountName: "Payment Gateway",
        upiId: "zapupi",
        status: "approved",
        source: "gateway",
        orderId: orderId,
        createdAt: FieldValue.serverTimestamp(),
        approvedAt: FieldValue.serverTimestamp(),
        notified: true,
      });
    });

    console.log("[zap-webhook] Credited + deposit entry:", orderId, paidAmount);
    return res.status(200).json({ status: "ok" });
  } catch (e) {
    console.error("[zap-webhook] Webhook error:", e);
    return res.status(500).json({ error: "error" });
  }
});

// ============================================================
// PART 2: ARENAX-NOTIFY-SERVER (deposit/withdraw/result/room/broadcast)
// ============================================================
async function sendToUser(uid, title, body, link) {
  try {
    const userSnap = await firexDb.collection("users").doc(uid).get();
    const userData = userSnap.data();
    if (!userData) return;
    if (userData.notificationsEnabled === false) {
      console.log(`[arenax-notify] Notifications disabled for uid ${uid}, skipping`);
      return;
    }
    const token = userData.fcmToken;
    if (!token) {
      console.log(`[arenax-notify] No fcmToken for uid ${uid}, skipping`);
      return;
    }
    await firexApp.messaging().send({
      token,
      notification: { title, body },
      data: { link: link || "" },
    });
    console.log(`[arenax-notify] Sent to ${uid}: ${title}`);
  } catch (err) {
    console.error(`[arenax-notify] Failed to send to ${uid}:`, err.message);
  }
}

async function notifyMatchParticipants(matchRef, title, body) {
  const participantsSnap = await matchRef.collection("participants").get();
  await Promise.all(
    participantsSnap.docs.map((p) => sendToUser(p.id, title, body))
  );
  return participantsSnap.size;
}

firexDb.collection("deposit_requests").onSnapshot(
  (snap) => {
    snap.docChanges().forEach(async (change) => {
      if (change.type !== "modified") return;
      const d = change.doc.data();
      if (d.notified) return;
      if (d.status === "approved" || d.status === "rejected") {
        await sendToUser(
          d.uid,
          d.status === "approved" ? "Deposit Approved" : "Deposit Rejected",
          `Your deposit of Rs.${d.amount} was ${d.status}.`
        );
        await change.doc.ref.update({ notified: true });
      }
    });
  },
  (err) => console.error("[arenax-notify] deposit_requests listener error:", err)
);

firexDb.collection("withdraw_requests").onSnapshot(
  (snap) => {
    snap.docChanges().forEach(async (change) => {
      if (change.type !== "modified") return;
      const d = change.doc.data();
      if (d.notified) return;
      if (d.status === "approved" || d.status === "rejected") {
        await sendToUser(
          d.uid,
          d.status === "approved" ? "Withdraw Approved" : "Withdraw Rejected",
          `Your withdraw of Rs.${d.amount} was ${d.status}.`
        );
        await change.doc.ref.update({ notified: true });
      }
    });
  },
  (err) => console.error("[arenax-notify] withdraw_requests listener error:", err)
);

firexDb.collection("matches").onSnapshot(
  (snap) => {
    snap.docChanges().forEach(async (change) => {
      if (change.type !== "modified") return;
      const d = change.doc.data();
      if (d.resultsDeclared === true && d.resultsNotified === false) {
        const count = await notifyMatchParticipants(
          change.doc.ref,
          "Match Result Declared",
          `Results for "${d.title || "your match"}" are out! Check your prize.`
        );
        await change.doc.ref.update({ resultsNotified: true });
        console.log(
          `[arenax-notify] Result notification sent to ${count} participant(s) for match ${change.doc.id}`
        );
      }
    });
  },
  (err) => console.error("[arenax-notify] matches listener error:", err)
);

const ROOM_NOTIFY_CHECK_INTERVAL_MS = 20 * 1000;

async function checkAndSendRoomNotifications() {
  try {
    const snap = await firexDb.collection("matches").where("roomNotifSent", "==", false).get();
    if (snap.empty) return;
    const now = Date.now();

    for (const doc of snap.docs) {
      const d = doc.data();
      const roomId = String(d.roomId || "").trim();
      const roomPassword = String(d.roomPassword || "").trim();
      if (!roomId || !roomPassword) continue;

      const matchTime = d.matchDateTime && d.matchDateTime.toMillis ? d.matchDateTime.toMillis() : null;
      if (matchTime === null) continue;
      if (matchTime > now) continue;

      const count = await notifyMatchParticipants(
        doc.ref,
        "Room ID Available",
        `Room ID & Password for "${d.title || "your match"}" is out. Match starting now!`
      );
      await doc.ref.update({ roomNotifSent: true });
      console.log(`[arenax-notify] Room notification sent to ${count} participant(s) for match ${doc.id}`);
    }
  } catch (err) {
    console.error("[arenax-notify] Room notification check failed:", err.message);
  }
}
setInterval(checkAndSendRoomNotifications, ROOM_NOTIFY_CHECK_INTERVAL_MS);
checkAndSendRoomNotifications();

app.post("/send-broadcast", async (req, res) => {
  if (req.headers["x-api-key"] !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const { title, body, link } = req.body;
  if (!title || !body) {
    return res.status(400).json({ error: "title and body are required" });
  }
  try {
    await firexApp.messaging().send({
      topic: "all_users",
      notification: { title, body },
      data: { link: link || "" },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[arenax-notify] Broadcast failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PART 3: REFER-SYSTEM (referral code apply)
// Route change ho gaya hai: /apply-referral -> /refer/apply-referral
// ============================================================
app.post("/refer/apply-referral", async (req, res) => {
  try {
    const { uid, username, referralCode } = req.body;

    if (!uid || !referralCode) {
      return res.status(400).json({ ok: false, message: "uid/referralCode missing" });
    }

    const entered = referralCode.trim().toUpperCase();

    const codeDoc = await firexDb.collection("referral_codes").doc(entered).get();
    if (!codeDoc.exists) {
      return res.json({ ok: false, message: "Invalid referral code" });
    }

    const referrerUid = codeDoc.data().uid;
    if (!referrerUid || referrerUid === uid) {
      return res.json({ ok: false, message: "Cannot refer yourself" });
    }

    const offerDoc = await firexDb.collection("settings").doc("refer_earn").get();
    const offer = offerDoc.exists ? offerDoc.data() : {};
    if (offer.enabled !== true) {
      return res.json({ ok: false, message: "Refer & Earn is currently disabled" });
    }

    const referrerReward = Number(offer.referrerReward || 0);
    const refereeReward = Number(offer.refereeReward || 0);

    const alreadyDone = await firexDb
      .collection("referrals")
      .where("refereeUid", "==", uid)
      .limit(1)
      .get();
    if (!alreadyDone.empty) {
      return res.json({ ok: false, message: "Referral already applied for this user" });
    }

    const batch = firexDb.batch();

    if (refereeReward > 0) {
      const refereeRef = firexDb.collection("users").doc(uid);
      batch.update(refereeRef, {
        joinPoints: FieldValue.increment(refereeReward),
        walletPoints: FieldValue.increment(refereeReward),
      });
      const refereeHistRef = refereeRef.collection("wallet_history").doc();
      batch.set(refereeHistRef, {
        type: "credit",
        title: `Refer & Earn — signup bonus (${entered})`,
        amount: refereeReward,
        balance_after: null,
        date: FieldValue.serverTimestamp(),
      });
    }

    if (referrerReward > 0) {
      const referrerRef = firexDb.collection("users").doc(referrerUid);
      batch.update(referrerRef, {
        joinPoints: FieldValue.increment(referrerReward),
        walletPoints: FieldValue.increment(referrerReward),
      });
      const referrerHistRef = referrerRef.collection("wallet_history").doc();
      batch.set(referrerHistRef, {
        type: "credit",
        title: `Refer & Earn — ${username || "New player"} signed up with your code`,
        amount: referrerReward,
        balance_after: null,
        date: FieldValue.serverTimestamp(),
      });
    }

    const codeRef = firexDb.collection("referral_codes").doc(entered);
    batch.update(codeRef, { usedCount: FieldValue.increment(1) });

    const referralsRef = firexDb.collection("referrals").doc();
    batch.set(referralsRef, {
      referrerUid,
      refereeUid: uid,
      refereeUsername: username || "",
      referrerReward,
      refereeReward,
      createdAt: FieldValue.serverTimestamp(),
    });

    await batch.commit();

    return res.json({ ok: true, message: "Referral applied successfully" });
  } catch (err) {
    console.error("[refer-system]", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// ============================================================
// PART 4: SHUBH-SANKALP-NOTIFY-SERVER (leads -> push notification)
// ============================================================
let shubhIsFirstSnapshot = true;
shubhDb.collection("leads").onSnapshot(
  (snapshot) => {
    if (shubhIsFirstSnapshot) {
      shubhIsFirstSnapshot = false;
      // NOTE: purane code me pehla snapshot skip nahi hota tha, lekin
      // deploy/restart ke waqt saare purane leads dobara notify na ho
      // isliye pehla batch chhod dena safe hai (jaisa atc-notify karta hai).
      // Agar tum bilkul original wala behaviour chahte ho (restart pe bhi
      // pehla batch process ho), to neeche wala 'return' hata dena.
    }
    snapshot.docChanges().forEach(async (change) => {
      if (change.type === "added") {
        const lead = change.doc.data();
        console.log("[shubh-sankalp] New Lead:", change.doc.id, lead);
        await sendShubhNotificationToAllDevices(lead);
      }
    });
  },
  (error) => console.error("[shubh-sankalp] Firestore Listener Error:", error)
);

async function sendShubhNotificationToAllDevices(lead) {
  try {
    const tokensSnap = await shubhDb.collection("deviceTokens").get();
    if (tokensSnap.empty) {
      console.log("[shubh-sankalp] No device tokens found.");
      return;
    }
    const tokens = [];
    const docIds = [];
    tokensSnap.forEach((doc) => {
      const data = doc.data();
      if (data.token) {
        tokens.push(data.token);
        docIds.push(doc.id);
      }
    });
    const message = {
      notification: {
        title: "📩 New Website Enquiry",
        body: `${lead.name || "Someone"} submitted a new enquiry.`,
      },
      tokens: tokens,
    };
    const response = await shubhApp.messaging().sendEachForMulticast(message);
    console.log(
      `[shubh-sankalp] Notification Result — Success: ${response.successCount}, Failed: ${response.failureCount}`
    );
    response.responses.forEach((resp, index) => {
      if (!resp.success) {
        if (
          resp.error?.code === "messaging/registration-token-not-registered" ||
          resp.error?.code === "messaging/invalid-registration-token"
        ) {
          shubhDb
            .collection("deviceTokens")
            .doc(docIds[index])
            .delete()
            .then(() => console.log("[shubh-sankalp] Deleted invalid token:", docIds[index]))
            .catch(console.error);
        }
      }
    });
  } catch (err) {
    console.error("[shubh-sankalp] Notification Send Error:", err);
  }
}

// ============================================================
// PART 5: ATC-NOTIFY-SERVER (inquiries -> push notification)
// ============================================================
async function sendAtcNotification(title, body, data = {}) {
  const tokensSnap = await atcDb.collection("device_tokens").get();
  const tokens = tokensSnap.docs.map((d) => d.id);
  if (tokens.length === 0) {
    console.log("[atc-notify] No device tokens saved, skipping.");
    return;
  }
  const message = { notification: { title, body }, data, tokens };
  const response = await atcApp.messaging().sendEachForMulticast(message);
  console.log(`[atc-notify] Sent: ${response.successCount}, Failed: ${response.failureCount}`);
  response.responses.forEach((r, i) => {
    if (!r.success && r.error?.code === "messaging/registration-token-not-registered") {
      atcDb.collection("device_tokens").doc(tokens[i]).delete();
    }
  });
}

let atcIsFirstSnapshot = true;
atcDb
  .collection("inquiries")
  .orderBy("createdAt", "desc")
  .limit(10)
  .onSnapshot(
    (snapshot) => {
      if (atcIsFirstSnapshot) {
        atcIsFirstSnapshot = false;
        return;
      }
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added") {
          const d = change.doc.data();
          console.log("[atc-notify] New inquiry detected:", change.doc.id);
          sendAtcNotification(
            "New Inquiry! 🔔",
            `${d.name || "Someone"} wants: ${d.service || "a service"}`,
            { inquiryId: change.doc.id, type: "new_inquiry" }
          );
        }
      });
    },
    (err) => console.error("[atc-notify] Firestore listener error:", err)
  );

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Merged server running on port", PORT));
