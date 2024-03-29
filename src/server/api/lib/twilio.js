import Twilio from "twilio";
import { getFormattedPhoneNumber } from "../../../lib/phone-format";
import { Log, Message, PendingMessagePart, r } from "../../models";
import { log } from "../../../lib";
import { getLastMessage, saveNewIncomingMessage } from "./message-sending";

// TWILIO error_codes:
// > 1 (i.e. positive) error_codes are reserved for Twilio error codes
// -1 - -MAX_SEND_ATTEMPTS (5): failed send messages
// -100-....: custom local errors
// -101: incoming message with a MediaUrl

let twilio = null;
const MAX_SEND_ATTEMPTS = 5;
const MESSAGE_VALIDITY_PADDING_SECONDS = 30;
const MAX_TWILIO_MESSAGE_VALIDITY = 14400;
const DISABLE_DB_LOG = process.env.DISABLE_DB_LOG || global.DISABLE_DB_LOG;

if (process.env.TWILIO_API_KEY && process.env.TWILIO_AUTH_TOKEN) {
  // eslint-disable-next-line new-cap
  twilio = Twilio(process.env.TWILIO_API_KEY, process.env.TWILIO_AUTH_TOKEN);
} else {
  log.warn("NO TWILIO CONNECTION");
}

if (!process.env.TWILIO_MESSAGE_SERVICE_SID) {
  log.warn(
    "Twilio will not be able to send without TWILIO_MESSAGE_SERVICE_SID set"
  );
}

function webhook() {
  log.warn("twilio webhook call"); // sky: doesn't run this
  if (twilio) {
    return Twilio.webhook();
  } else {
    log.warn("NO TWILIO WEB VALIDATION");
    return function(req, res, next) {
      next();
    };
  }
}

async function convertMessagePartsToMessage(messageParts) {
  const firstPart = messageParts[0];
  const userNumber = firstPart.user_number;
  const contactNumber = firstPart.contact_number;
  const serviceMessages = messageParts.map(part =>
    JSON.parse(part.service_message)
  );
  const text = serviceMessages
    .map(serviceMessage => serviceMessage.Body)
    .join("")
    .replace(/\0/g, ""); // strip all UTF-8 null characters (0x00)

  const lastMessage = await getLastMessage({
    contactNumber
  });
  if (!lastMessage) {
    return;
  }
  return new Message({
    contact_number: contactNumber,
    user_number: userNumber,
    is_from_contact: true,
    text,
    error_code: null,
    service_id: firstPart.service_id,
    assignment_id: lastMessage.assignment_id,
    service: "twilio",
    send_status: "DELIVERED"
  });
}

async function findNewCell() {
  if (!twilio) {
    return { availablePhoneNumbers: [{ phone_number: "+15005550006" }] };
  }
  return new Promise((resolve, reject) => {
    twilio.availablePhoneNumbers("US").local.list({}, (err, data) => {
      if (err) {
        reject(new Error(err));
      } else {
        resolve(data);
      }
    });
  });
}

async function rentNewCell() {
  if (!twilio) {
    const num = "1234"
      .split("")
      .map(() => parseInt(Math.random() * 10))
      .join("");
    return getFormattedPhoneNumber(`+1212555${num}`);
  }
  const newCell = await findNewCell();

  if (
    newCell &&
    newCell.availablePhoneNumbers &&
    newCell.availablePhoneNumbers[0] &&
    newCell.availablePhoneNumbers[0].phone_number
  ) {
    return new Promise((resolve, reject) => {
      twilio.incomingPhoneNumbers.create(
        {
          phoneNumber: newCell.availablePhoneNumbers[0].phone_number,
          smsApplicationSid: process.env.TWILIO_APPLICATION_SID
        },
        (err, purchasedNumber) => {
          if (err) {
            reject(err);
          } else {
            resolve(purchasedNumber.phone_number);
          }
        }
      );
    });
  }

  throw new Error("Did not find any cell");
}

const mediaExtractor = new RegExp(/\[\s*(http[^\]\s]*)\s*\]/);

function parseMessageText(message) {
  const text = message.text || "";
  const params = {
    body: text.replace(mediaExtractor, "")
  };
  // Image extraction
  const results = text.match(mediaExtractor);
  if (results) {
    params.mediaUrl = results[1];
  }
  return params;
}

async function sendMessage(message, contact, trx) {
  if (!twilio) {
    log.warn(
      "cannot actually send SMS message -- twilio is not fully configured:",
      message.id
    );
    if (message.id) {
      const options = trx ? { transaction: trx } : {};
      await Message.get(message.id).update(
        { send_status: "SENT", sent_at: new Date() },
        options
      );
    }
    return "test_message_uuid";
  }

  return new Promise((resolve, reject) => {
    if (message.service !== "twilio") {
      log.warn("Message not marked as a twilio message", message.id);
    }

    const messageParams = Object.assign(
      {
        to: message.contact_number,
        body: message.text,
        messagingServiceSid: process.env.TWILIO_MESSAGE_SERVICE_SID,
        statusCallback: process.env.TWILIO_STATUS_CALLBACK_URL
      },
      parseMessageText(message)
    );

    let twilioValidityPeriod = process.env.TWILIO_MESSAGE_VALIDITY_PERIOD;

    if (message.send_before) {
      // the message is valid no longer than the time between now and
      // the send_before time, less 30 seconds
      // we subtract the MESSAGE_VALIDITY_PADDING_SECONDS seconds to allow time for the message to be sent by
      // a downstream service
      const messageValidityPeriod =
        Math.ceil((message.send_before - Date.now()) / 1000) -
        MESSAGE_VALIDITY_PADDING_SECONDS;

      if (messageValidityPeriod < 0) {
        // this is an edge case
        // it means the message arrived in this function already too late to be sent
        // pass the negative validity period to twilio, and let twilio respond with an error
      }

      if (twilioValidityPeriod) {
        twilioValidityPeriod = Math.min(
          twilioValidityPeriod,
          messageValidityPeriod,
          MAX_TWILIO_MESSAGE_VALIDITY
        );
      } else {
        twilioValidityPeriod = Math.min(
          messageValidityPeriod,
          MAX_TWILIO_MESSAGE_VALIDITY
        );
      }
    }

    if (twilioValidityPeriod) {
      messageParams.validityPeriod = twilioValidityPeriod;
    }

    twilio.messages.create(messageParams, (err, response) => {
      postMessageSend(message, contact, trx, resolve, reject, err, response);
    });
  });
}

export function postMessageSend(
  message,
  contact,
  trx,
  resolve,
  reject,
  err,
  response
) {
  const messageToSave = {
    ...message
  };
  log.info("messageToSave", messageToSave);
  let hasError = false;
  if (err) {
    hasError = true;
    log.error("Error sending message", err);
    console.log("Error sending message", err);
  }
  if (response) {
    messageToSave.service_id = response.sid;
    hasError = !!response.error_code;
    if (hasError) {
      messageToSave.error_code = response.error_code;
      messageToSave.send_status = "ERROR";
    }
  }

  if (hasError) {
    if (err) {
      if (messageToSave.error_code <= -MAX_SEND_ATTEMPTS) {
        messageToSave.send_status = "ERROR";
      }
      // decrement error code starting from zero
      messageToSave.error_code = Number(messageToSave.error_code || 0) - 1;
    }

    let contactUpdateQuery = Promise.resolve(1);
    if (contact && messageToSave.error_code) {
      contactUpdateQuery = r
        .knex("campaign_contact")
        .where("id", contact.id)
        .update("error_code", messageToSave.error_code);
    }
    let options = { conflict: "update" };
    if (trx) {
      options.transaction = trx;
      if (contact && messageToSave.error_code < 0) {
        contactUpdateQuery = contactUpdateQuery.transacting(trx);
      }
    }

    Promise.all([
      Message.save(messageToSave, options),
      contactUpdateQuery
    ]).then(() => {
      reject(
        err ||
          (response
            ? new Error(JSON.stringify(response))
            : new Error("Encountered unknown error"))
      );
    });
  } else {
    let options = { conflict: "update" };
    if (trx) {
      options.transaction = trx;
    }
    Message.save(
      {
        ...messageToSave,
        send_status: "SENT",
        service: "twilio",
        sent_at: new Date()
      },
      options
    ).then((newMessage, saveError) => {
      resolve(newMessage);
    });
  }
}

async function handleDeliveryReport(report) {
  const messageSid = report.MessageSid;
  if (messageSid && !DISABLE_DB_LOG) {
    await Log.save({
      message_sid: report.MessageSid,
      body: JSON.stringify(report),
      error_code: Number(report.ErrorCode) || 0,
      from_num: report.From || null,
      to_num: report.To || null
    });
    const messageStatus = report.MessageStatus;
    const message = await r
      .table("message")
      .getAll(messageSid, { index: "service_id" })
      .limit(1)(0)
      .default(null);
    if (message) {
      message.service_response_at = new Date();
      if (messageStatus === "delivered") {
        message.send_status = "DELIVERED";
      } else if (
        messageStatus === "failed" ||
        messageStatus === "undelivered"
      ) {
        message.send_status = "ERROR";
        message.error_code = Number(report.ErrorCode) || 0;
      }
      await Message.save(message, { conflict: "update" });

      // FUTURE: update campaign_contact.error_code based on message.campaign_contact_id
    }
  }
}

async function handleIncomingMessage(message) {
  if (
    !message.hasOwnProperty("From") ||
    !message.hasOwnProperty("To") ||
    !message.hasOwnProperty("Body") ||
    !message.hasOwnProperty("MessageSid")
  ) {
    log.error(`This is not an incoming message: ${JSON.stringify(message)}`);
  }

  const { From, To, MessageSid } = message;
  const contactNumber = getFormattedPhoneNumber(From);
  const userNumber = To ? getFormattedPhoneNumber(To) : "";

  const pendingMessagePart = new PendingMessagePart({
    service: "twilio",
    service_id: MessageSid,
    parent_id: null,
    service_message: JSON.stringify(message),
    user_number: userNumber,
    contact_number: contactNumber
  });
  if (!process.env.JOBS_SAME_PROCESS) {
    // If multiple processes, just insert the message part and let another job handle it
    await r.knex("pending_message_part").insert(pendingMessagePart);
  } else {
    // Handle the message directly and skip saving an intermediate part
    const finalMessage = await convertMessagePartsToMessage([
      pendingMessagePart
    ]);
    if (finalMessage) {
      if (message.spokeCreatedAt) {
        finalMessage.created_at = message.spokeCreatedAt;
      }
      await saveNewIncomingMessage(finalMessage);
    }
  }

  // store mediaurl data in Log, so it can be extracted manually
  if (message.MediaUrl0 && !DISABLE_DB_LOG) {
    await Log.save({
      message_sid: MessageSid,
      body: JSON.stringify(message),
      error_code: -101,
      from_num: From || null,
      to_num: To || null
    });
  }
}

export default {
  syncMessagePartProcessing: !!process.env.JOBS_SAME_PROCESS,
  webhook,
  convertMessagePartsToMessage,
  findNewCell,
  rentNewCell,
  sendMessage,
  handleDeliveryReport,
  handleIncomingMessage,
  parseMessageText
};
