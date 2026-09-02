const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();

const app = express();

const PORT = process.env.PORT || 10000;

const BACKEND_URL =
    process.env.BACKEND_URL ||
    "https://nyota-backed1.onrender.com";

const PAYLOR_API_KEY =
    process.env.PAYLOR_API_KEY;

const PAYLOR_CHANNEL_ID =
    process.env.PAYLOR_CHANNEL_ID;

const PAYLOR_WEBHOOK_SECRET =
    process.env.PAYLOR_WEBHOOK_SECRET;


/* =====================================================
   PAYLOR API
===================================================== */

const PAYLOR_STK_URL =
    "https://api.paylorke.com/api/v1/merchants/payments/stk-push";

const PAYLOR_TRANSACTION_URL =
    "https://api.paylorke.com/api/v1/merchants/payments/transactions";


/* =====================================================
   MIDDLEWARE
===================================================== */

app.use(cors());

app.use(
    express.json({
        verify: (req, res, buf) => {
            req.rawBody = Buffer.from(buf);
        }
    })
);


/* =====================================================
   TEMPORARY PAYMENT STORAGE
===================================================== */

const payments = new Map();


/* =====================================================
   HOME
===================================================== */

app.get("/", (req, res) => {

    res.json({
        success: true,
        service: "Nyota Payment Backend",
        provider: "Paylor",
        status: "online"
    });

});


/* =====================================================
   HEALTH CHECK
===================================================== */

app.get("/health", (req, res) => {

    res.json({
        success: true,
        status: "healthy",

        paylorConfigured:
            Boolean(
                PAYLOR_API_KEY &&
                PAYLOR_CHANNEL_ID
            ),

        webhookConfigured:
            Boolean(
                PAYLOR_WEBHOOK_SECRET
            ),

        backendUrl:
            BACKEND_URL
    });

});


/* =====================================================
   NORMALIZE KENYAN PHONE
===================================================== */

function normalizePhone(phone) {

    let value =
        String(phone || "")
            .trim()
            .replace(/\s+/g, "")
            .replace(/-/g, "");

    if (value.startsWith("+254")) {
        value = value.substring(1);
    }

    if (value.startsWith("07")) {
        value =
            "254" +
            value.substring(1);
    }

    if (value.startsWith("01")) {
        value =
            "254" +
            value.substring(1);
    }

    return value;
}


/* =====================================================
   CREATE PAYMENT REFERENCE
===================================================== */

function createReference() {

    return (
        "NYOTA-" +
        Date.now() +
        "-" +
        crypto
            .randomBytes(4)
            .toString("hex")
            .toUpperCase()
    );

}


/* =====================================================
   STK PUSH
===================================================== */

app.post(
    "/api/payment/stk-push",
    async (req, res) => {

        try {

            const {
                phone,
                amount,
                reference,
                description
            } = req.body;


            /* -----------------------------------------
               CHECK CONFIGURATION
            ----------------------------------------- */

            if (
                !PAYLOR_API_KEY ||
                !PAYLOR_CHANNEL_ID
            ) {

                console.error(
                    "Paylor credentials are not configured."
                );

                return res.status(500).json({

                    success: false,

                    error:
                        "Payment service is not configured."

                });

            }


            /* -----------------------------------------
               PHONE
            ----------------------------------------- */

            if (!phone) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Phone number is required."

                });

            }


            const normalizedPhone =
                normalizePhone(phone);


            if (
                !/^254\d{9}$/.test(
                    normalizedPhone
                )
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Invalid Kenyan M-PESA phone number."

                });

            }


            /* -----------------------------------------
               AMOUNT
            ----------------------------------------- */

            const numericAmount =
                Number(amount);


            if (
                !Number.isFinite(
                    numericAmount
                ) ||
                numericAmount <= 0
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Invalid payment amount."

                });

            }


            /* -----------------------------------------
               REFERENCE
            ----------------------------------------- */

            const paymentReference =
                String(
                    reference ||
                    createReference()
                );


            /* -----------------------------------------
               CALLBACK
            ----------------------------------------- */

            const callbackUrl =
                `${BACKEND_URL}/paylor-callback`;


            /* -----------------------------------------
               PAYLOR PAYLOAD
            ----------------------------------------- */

            const payload = {

                phone:
                    normalizedPhone,

                amount:
                    numericAmount,

                reference:
                    paymentReference,

                channelId:
                    PAYLOR_CHANNEL_ID,

                description:
                    description ||
                    "Private service payment",

                callbackUrl

            };


            console.log(
                "PAYLOR STK REQUEST",
                {
                    phone:
                        normalizedPhone,

                    amount:
                        numericAmount,

                    reference:
                        paymentReference
                }
            );


            /* -----------------------------------------
               SEND TO PAYLOR
            ----------------------------------------- */

            const response =
                await fetch(
                    PAYLOR_STK_URL,
                    {

                        method: "POST",

                        headers: {

                            "Authorization":
                                `Bearer ${PAYLOR_API_KEY}`,

                            "Content-Type":
                                "application/json",

                            "Idempotency-Key":
                                paymentReference

                        },

                        body:
                            JSON.stringify(
                                payload
                            )

                    }
                );


            const responseText =
                await response.text();


            let data;

            try {

                data =
                    JSON.parse(
                        responseText
                    );

            } catch {

                data = {
                    raw:
                        responseText
                };

            }


            console.log(
                "PAYLOR RESPONSE",
                response.status,
                data
            );


            /* -----------------------------------------
               PAYLOR REJECTED REQUEST
            ----------------------------------------- */

            if (!response.ok) {

                return res.status(
                    response.status
                ).json({

                    success: false,

                    error:
                        data.message ||
                        data.error ||
                        "Paylor rejected the payment request.",

                    paylor:
                        data

                });

            }


            /* -----------------------------------------
               PAYLOR TRANSACTION ID
            ----------------------------------------- */

            const transactionId =
                data.transactionId ||
                data.id ||
                data.checkout_request_id ||
                null;


            /* -----------------------------------------
               SAVE PAYMENT
            ----------------------------------------- */

            payments.set(
                paymentReference,
                {

                    reference:
                        paymentReference,

                    transactionId:
                        transactionId,

                    phone:
                        normalizedPhone,

                    amount:
                        numericAmount,

                    status:
                        String(
                            data.status ||
                            "SENT"
                        ).toUpperCase(),

                    createdAt:
                        new Date().toISOString()

                }
            );


            /* -----------------------------------------
               RESPONSE TO FRONTEND
            ----------------------------------------- */

            return res.json({

                success: true,

                message:
                    "STK Push sent.",

                reference:
                    paymentReference,

                transactionId:
                    transactionId,

                checkout_request_id:
                    transactionId,

                status:
                    String(
                        data.status ||
                        "SENT"
                    ).toUpperCase()

            });


        } catch (error) {

            console.error(
                "STK PUSH ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                error:
                    "Unable to initiate payment.",

                message:
                    error.message

            });

        }

    }
);


/* =====================================================
   PAYMENT STATUS
===================================================== */

app.get(
    "/api/payment/status",
    async (req, res) => {

        try {

            const reference =
                String(
                    req.query.reference ||
                    ""
                ).trim();


            const transactionId =
                String(
                    req.query.transactionId ||
                    ""
                ).trim();


            if (
                !reference &&
                !transactionId
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Reference or transactionId is required."

                });

            }


            /* -----------------------------------------
               FIND LOCAL PAYMENT
            ----------------------------------------- */

            let payment =
                reference
                    ? payments.get(reference)
                    : null;


            /* -----------------------------------------
               ALREADY FINAL
            ----------------------------------------- */

            if (
                payment &&
                (
                    payment.status ===
                    "COMPLETED" ||

                    payment.status ===
                    "SUCCESS" ||

                    payment.status ===
                    "FAILED" ||

                    payment.status ===
                    "EXPIRED"
                )
            ) {

                return res.json({

                    success: true,

                    ...payment

                });

            }


            /* -----------------------------------------
               TRANSACTION ID
            ----------------------------------------- */

            const id =
                transactionId ||
                payment?.transactionId;


            if (!id) {

                return res.json({

                    success: true,

                    reference:
                        reference,

                    status:
                        payment?.status ||
                        "PENDING"

                });

            }


            /* -----------------------------------------
               QUERY PAYLOR
            ----------------------------------------- */

            const response =
                await fetch(

                    `${PAYLOR_TRANSACTION_URL}/${encodeURIComponent(id)}`,

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


            const responseText =
                await response.text();


            let data;

            try {

                data =
                    JSON.parse(
                        responseText
                    );

            } catch {

                data = {};

            }


            console.log(
                "PAYLOR STATUS",
                response.status,
                data
            );


            /* -----------------------------------------
               TEMPORARY PAYLOR ERROR
            ----------------------------------------- */

            if (!response.ok) {

                return res.json({

                    success: true,

                    reference:
                        reference,

                    transactionId:
                        id,

                    status:
                        payment?.status ||
                        "PENDING"

                });

            }


            /* -----------------------------------------
               NORMALIZE STATUS
            ----------------------------------------- */

            const status =
                String(
                    data.status ||
                    payment?.status ||
                    "PENDING"
                ).toUpperCase();


            const finalReference =
                data.reference ||
                reference ||
                payment?.reference;


            const updatedPayment = {

                ...(payment || {}),

                reference:
                    finalReference,

                transactionId:
                    data.transactionId ||
                    data.id ||
                    id,

                amount:
                    data.amount ??
                    payment?.amount ??
                    null,

                status:
                    status,

                provider:
                    data.provider ||
                    payment?.provider ||
                    "MPESA",

                providerRef:
                    data.providerRef ||
                    payment?.providerRef ||
                    null,

                mpesaReceipt:
                    data.metadata?.mpesaReceipt ||
                    data.mpesaReceipt ||
                    payment?.mpesaReceipt ||
                    null,

                updatedAt:
                    new Date().toISOString()

            };


            payments.set(
                finalReference,
                updatedPayment
            );


            return res.json({

                success: true,

                ...updatedPayment

            });


        } catch (error) {

            console.error(
                "PAYMENT STATUS ERROR:",
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


/* =====================================================
   PAYLOR CALLBACK
===================================================== */

app.post(
    "/paylor-callback",
    (req, res) => {

        try {

            /* -----------------------------------------
               CHECK SECRET
            ----------------------------------------- */

            if (!PAYLOR_WEBHOOK_SECRET) {

                console.error(
                    "Webhook secret is missing."
                );

                return res.status(500).json({

                    success: false,

                    error:
                        "Webhook configuration error."

                });

            }


            /* -----------------------------------------
               SIGNATURE
            ----------------------------------------- */

            const signature =
                req.headers[
                    "x-webhook-signature"
                ];


            if (!signature) {

                return res.status(401).json({

                    success: false,

                    error:
                        "Missing webhook signature."

                });

            }


            /* -----------------------------------------
               CREATE EXPECTED SIGNATURE
            ----------------------------------------- */

            const expected =
                crypto
                    .createHmac(
                        "sha256",
                        PAYLOR_WEBHOOK_SECRET
                    )
                    .update(
                        req.rawBody
                    )
                    .digest("hex");


            const receivedBuffer =
                Buffer.from(
                    String(signature)
                        .trim()
                        .toLowerCase()
                );

            const expectedBuffer =
                Buffer.from(
                    expected
                        .trim()
                        .toLowerCase()
                );


            if (
                receivedBuffer.length !==
                expectedBuffer.length ||
                !crypto.timingSafeEqual(
                    receivedBuffer,
                    expectedBuffer
                )
            ) {

                console.warn(
                    "Invalid Paylor webhook signature."
                );

                return res.status(401).json({

                    success: false,

                    error:
                        "Invalid webhook signature."

                });

            }


            /* -----------------------------------------
               VERIFIED CALLBACK
            ----------------------------------------- */

            const body =
                req.body;


            console.log(
                "VERIFIED PAYLOR CALLBACK"
            );

            console.log(
                JSON.stringify(
                    body,
                    null,
                    2
                )
            );


            /* -----------------------------------------
               SUPPORT COMMON PAYLOR STRUCTURES
            ----------------------------------------- */

            const event =
                body.event ||
                "";

            const transaction =
                body.transaction ||
                body;


            const reference =
                transaction.reference ||
                body.reference;


            if (!reference) {

                return res.json({

                    received: true

                });

            }


            const existing =
                payments.get(
                    reference
                ) || {};


            /* -----------------------------------------
               DETERMINE STATUS
            ----------------------------------------- */

            let status =
                String(
                    transaction.status ||
                    body.status ||
                    ""
                ).toUpperCase();


            if (
                event ===
                "payment.success"
            ) {

                status =
                    "COMPLETED";

            }


            if (
                event ===
                "payment.failed"
            ) {

                status =
                    "FAILED";

            }


            if (
                event ===
                "payment.expired"
            ) {

                status =
                    "EXPIRED";

            }


            /* -----------------------------------------
               UPDATE PAYMENT
            ----------------------------------------- */

            const updatedPayment = {

                ...existing,

                reference:
                    reference,

                transactionId:
                    transaction.transactionId ||
                    transaction.id ||
                    existing.transactionId ||
                    null,

                amount:
                    transaction.amount ??
                    existing.amount ??
                    null,

                phone:
                    transaction.phone ||
                    existing.phone ||
                    null,

                status:
                    status ||
                    existing.status ||
                    "PENDING",

                provider:
                    transaction.provider ||
                    existing.provider ||
                    "MPESA",

                providerRef:
                    transaction.providerRef ||
                    existing.providerRef ||
                    null,

                mpesaReceipt:
                    transaction.metadata?.mpesaReceipt ||
                    transaction.mpesaReceipt ||
                    existing.mpesaReceipt ||
                    null,

                updatedAt:
                    new Date().toISOString()

            };


            payments.set(
                reference,
                updatedPayment
            );


            console.log(
                "PAYMENT UPDATED:",
                updatedPayment
            );


            return res.json({

                received: true

            });


        } catch (error) {

            console.error(
                "WEBHOOK ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                error:
                    "Callback processing failed."

            });

        }

    }
);


/* =====================================================
   OPTIONAL DIRECT STK ROUTE
===================================================== */

app.post(
    "/stk-push",
    async (req, res) => {

        req.url =
            "/api/payment/stk-push";

        return app._router.handle(
            req,
            res,
            () => {}
        );

    }
);


/* =====================================================
   404
===================================================== */

app.use(
    (req, res) => {

        res.status(404).json({

            success: false,

            error:
                "Route not found."

        });

    }
);


/* =====================================================
   SERVER
===================================================== */

app.listen(
    PORT,
    () => {

        console.log(
            "================================="
        );

        console.log(
            "NYOTA PAYMENT BACKEND ONLINE"
        );

        console.log(
            `PORT: ${PORT}`
        );

        console.log(
            `BACKEND: ${BACKEND_URL}`
        );

        console.log(
            `PAYLOR API: ${Boolean(
                PAYLOR_API_KEY
            )}`
        );

        console.log(
            `PAYLOR CHANNEL: ${Boolean(
                PAYLOR_CHANNEL_ID
            )}`
        );

        console.log(
            `WEBHOOK SECRET: ${Boolean(
                PAYLOR_WEBHOOK_SECRET
            )}`
        );

        console.log(
            "================================="
        );

    }
);
