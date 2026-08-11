import type { JetStreamClient, PubAck } from "@nats-io/jetstream";

import type { LifecycleRelayPorts } from "./work-item-lifecycle-relay.js";

export interface JetStreamLifecyclePublisherConfig {
  readonly stream: string;
  readonly subject: string;
}

const jetStreamName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;
const subjectToken = /^[A-Za-z0-9_-]+$/;

function requireSubject(subject: string): string {
  const tokens = subject.split(".");
  if (
    subject.length > 512 ||
    tokens.length < 2 ||
    tokens.some((token) => !subjectToken.test(token))
  ) {
    throw new Error("JetStream lifecycle subject is invalid");
  }
  return subject;
}

function requireAck(ack: PubAck, expectedStream: string): PubAck {
  if (
    ack.stream !== expectedStream ||
    !Number.isSafeInteger(ack.seq) ||
    ack.seq < 1 ||
    typeof ack.duplicate !== "boolean"
  ) {
    throw new Error("JetStream lifecycle publish acknowledgment is invalid");
  }
  return ack;
}

export function createJetStreamLifecyclePublisher(
  client: Pick<JetStreamClient, "publish">,
  input: JetStreamLifecyclePublisherConfig,
): LifecycleRelayPorts["publish"] {
  if (!jetStreamName.test(input.stream)) {
    throw new Error("JetStream lifecycle stream is invalid");
  }
  const subject = requireSubject(input.subject);
  return async ({ route, payload, messageId }) => {
    if (route !== "codeops.lifecycle.v1.events") {
      throw new Error("JetStream lifecycle route is unsupported");
    }
    const acknowledgment = requireAck(
      await client.publish(subject, payload, { msgID: messageId }),
      input.stream,
    );
    return {
      receipt: {
        driver: "jetstream",
        destination: acknowledgment.stream,
        position: String(acknowledgment.seq),
        metadata: {
          duplicate: acknowledgment.duplicate,
          subject,
        },
      },
    };
  };
}
