import serverless from "serverless-http";
import app from "./app";

export const handler = serverless(app, {
  provider: "aws",
  request(request, event: { body?: unknown; isBase64Encoded?: boolean }, context) {
    const raw =
      typeof event?.body === "string"
        ? event.isBase64Encoded
          ? Buffer.from(event.body, "base64").toString("utf8")
          : event.body
        : Buffer.isBuffer(event?.body)
          ? event.body.toString("utf8")
          : event?.body && typeof event.body === "object"
            ? JSON.stringify(event.body)
            : "";
    Object.assign(request, {
      apiGateway: { event, context },
      rawBody: raw,
    });
  },
});
