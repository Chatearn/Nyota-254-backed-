const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();

const app = express();

const PORT = process.env.PORT || 10000;

const PAYLOR_BASE_URL =
    "https://api.paylorke.com/api/v1";

const PAYLOR_API_KEY =
    process.env.PAYLOR_API_KEY;

const PAYLOR_CHANNEL_ID =
    process.env.PAYLOR_CHANNEL_ID;

const PAYLOR_WEBHOOK_SECRET =
    process.env.PAYLOR_WEBHOOK_SECRET;

const PUBLIC_BASE_URL =
    process.env.PUBLIC_BASE_URL;

app.use(cors());
app.use(express.json());

/*
=====================================================
 HEALTH CHECK
=====================================================
*/

app.get("/", (req, res) => {
    res.json({
        success: true,
        service: "Nyota Backed API",
        status: "online"
    });
});


/*
=====================================================
 NORMALIZE KENYAN PHONE
=====================================================
*/

function normalizePhone(phone) {

    let value = String(phone || "")
        .trim()
        .replace(/\s+/g, "")
        .replace(/-/g, "");

    if (value.startsWith("+254")) {
        value = value.substring(1);
    }

    if (value.startsWith("07") || value.startsWith("01")) {
        value = "254" + value.substring(1);
    }

    return value;
}


/*
=====================================================
 CREATE UNIQUE REFERENCE
=====================================================
*/

function createReference() {

    return (
        "NYOTA-" +
        Date.now() +
        "-" +
        crypto.randomBytes(4).toString("hex").toUpperCase()
    );

}


/*
=====================================================
 STK PUSH
=====================================================
*/

app.post("/api/payment/stk-push", async (req, res) => {

    try {

        if (!PAYLOR_API_KEY) {

            return res.status(500).json({
                success: false,
                error: "PAYLOR_API_KEY is not configured."
            });

        }

        const phone =
            normalizePhone(req.body.phone);

        const amount =
            Number(req.body.amount);

        const description =
            String(
                req.body.description ||
                "Nyota Backed payment"
            );

        if (!/^254\d{9}$/.test(phone)) {

            return res.status(400).json({
                success: false,
                error: "Invalid Kenyan phone number."
            });

        }

        if (
            !Number.isFinite(amount) ||
            amount <= 0
        ) {

            return res.status(400).json({
                success: false,
                error: "Invalid payment amount."
            });

        }

        const reference =
            createReference();

        const payload = {

            phone: phone,

            amount: amount,

            reference: reference,

            description: description

        };

        /*
        Add the configured Paylor channel
        when supplied in Render.
        */

        if (PAYLOR_CHANNEL_ID) {

            payload.channelId =
                PAYLOR_CHANNEL_ID;

        }

        /*
        Add webhook callback when the
        public Render URL is configured.
        */

        if (PUBLIC_BASE_URL) {

            payload.callbackUrl =
                PUBLIC_BASE_URL +
                "/api/paylor-callback";

        }

        console.log(
            "NYOTA STK REQUEST:",
            {
                phone,
                amount,
                reference
            }
        );

        const response =
            await fetch(
                PAYLOR_BASE_URL +
                "/merchants/payments/stk-push",
                {

                    method: "POST",

                    headers: {

                        "Authorization":
                            `Bearer ${PAYLOR_API_KEY}`,

                        "Content-Type":
                            "application/json",

                        "Idempotency-Key":
                            reference

                    },

                    body:
                        JSON.stringify(payload)

                }
            );

        const text =
            await response.text();

        let data;

        try {

            data =
                JSON.parse(text);

        } catch {

            data = {
                raw: text
            };

        }

        console.log(
            "PAYLOR RESPONSE:",
            data
        );

        if (!response.ok) {

            return res.status(response.status).json({

                success: false,

                error:
                    data.message ||
                    data.error ||
                    "Paylor STK Push failed.",

                paylor:
                    data

            });

        }

        const transactionId =
            data.transactionId ||
            data.id ||
            "";

        /*
        Store a small in-memory record.
        For production, use a database.
        */

        payments.set(
            reference,
            {

                reference,

                transactionId,

                phone,

                amount,

                status:
                    data.status ||
                    "SENT",

                createdAt:
                    new Date().toISOString()

            }
        );

        return res.json({

            success: true,

            reference,

            transactionId,

            status:
                data.status ||
                "SENT"

        });

    } catch (error) {

        console.error(
            "STK ERROR:",
            error
        );

        return res.status(500).json({

            success: false,

            error:
                "Unable to initiate payment."

        });

    }

});


/*
=====================================================
 PAYMENT STORAGE
=====================================================
*/

const payments =
    new Map();


/*
=====================================================
 PAYMENT STATUS
=====================================================
*/

app.get(
    "/api/payment/status",
    async (req, res) => {

        try {

            const reference =
                String(
                    req.query.reference ||
                    ""
                ).trim();

            if (!reference) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Payment reference is required."

                });

            }

            const payment =
                payments.get(reference);

            if (!payment) {

                return res.json({

                    success: true,

                    reference,

                    status: "NOT_FOUND"

                });

            }

            /*
            If we have a Paylor transaction ID,
            ask Paylor for the current status.
            */

            if (payment.transactionId) {

                const response =
                    await fetch(

                        PAYLOR_BASE_URL +
                        "/merchants/payments/transactions/" +
                        encodeURIComponent(
                            payment.transactionId
                        ),

                        {

                            method: "GET",

                            headers: {

                                "Authorization":
                                    `Bearer ${PAYLOR_API_KEY}`,

                                "Content-Type":
                                    "application/json"

                            }

                        }

                    );

                const text =
                    await response.text();

                let data;

                try {

                    data =
                        JSON.parse(text);

                } catch {

                    data = {};

                }

                console.log(
                    "PAYLOR STATUS:",
                    data
                );

                if (response.ok) {

                    payment.status =
                        data.status ||
                        payment.status;

                    payment.providerRef =
                        data.providerRef ||
                        payment.providerRef;

                    payment.mpesaReceipt =
                        data.metadata?.mpesaReceipt ||
                        payment.mpesaReceipt;

                    payments.set(
                        reference,
                        payment
                    );

                }

            }

            return res.json({

                success: true,

                reference:

                    payment.reference,

                transactionId:

                    payment.transactionId,

                status:

                    payment.status,

                providerRef:

                    payment.providerRef ||
                    "",

                mpesaReceipt:

                    payment.mpesaReceipt ||
                    ""

            });

        } catch (error) {

            console.error(
                "STATUS ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                error:
                    "Unable to check payment status."

            });

        }

    }
);


/*
=====================================================
 PAYLOR CALLBACK
=====================================================
*/

app.post(
    "/api/paylor-callback",
    (req, res) => {

        try {

            /*
            Paylor webhook verification should be
            enabled before treating callback data
            as trusted payment confirmation.

            The raw body/signature format should be
            matched to the Webhooks documentation
            for your Paylor account.
            */

            console.log(
                "PAYLOR CALLBACK RECEIVED:",
                req.body
            );

            const data =
                req.body || {};

            const reference =
                data.reference;

            if (reference) {

                const payment =
                    payments.get(reference);

                if (payment) {

                    payment.status =
                        data.status ||
                        payment.status;

                    payment.transactionId =
                        data.transactionId ||
                        payment.transactionId;

                    payment.providerRef =
                        data.providerRef ||
                        payment.providerRef;

                    payment.mpesaReceipt =
                        data.metadata?.mpesaReceipt ||
                        data.mpesaReceipt ||
                        payment.mpesaReceipt;

                    payments.set(
                        reference,
                        payment
                    );

                }

            }

            return res.json({
                success: true
            });

        } catch (error) {

            console.error(
                "CALLBACK ERROR:",
                error
            );

            return res.status(500).json({
                success: false
            });

        }

    }
);


/*
=====================================================
 START SERVER
=====================================================
*/

app.listen(
    PORT,
    () => {

        console.log(
            `Nyota Backed API running on port ${PORT}`
        );

    }
);
