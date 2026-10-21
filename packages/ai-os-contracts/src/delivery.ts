import * as Schema from "effect/Schema";

import {
  ArtifactRevisionV1,
  ContractId,
  ContractVersion,
  IsoDateTime,
  strictParse,
} from "./common.ts";

export const DeliveryDestinationV1 = Schema.Literals(["dashboard", "conversation"]);
export type DeliveryDestinationV1 = typeof DeliveryDestinationV1.Type;

export const ResultDeliveryV1 = Schema.Struct({
  version: ContractVersion,
  taskId: ContractId,
  attemptId: ContractId,
  acceptedRevision: ArtifactRevisionV1,
  destination: DeliveryDestinationV1,
  idempotencyKey: ContractId,
  conversationId: Schema.optionalKey(ContractId),
  deliveredAt: IsoDateTime,
}).check(
  Schema.makeFilter((delivery) => {
    if (delivery.destination === "conversation") {
      return delivery.conversationId === undefined
        ? "A conversation delivery names the originating conversation."
        : true;
    }
    return delivery.conversationId === undefined
      ? true
      : "A dashboard delivery has no conversation id.";
  }),
);
export type ResultDeliveryV1 = typeof ResultDeliveryV1.Type;

export const DeliveryAckV1 = Schema.Struct({
  deliveryId: ContractId,
  idempotencyKey: ContractId,
  destination: DeliveryDestinationV1,
  acceptedRevision: ArtifactRevisionV1,
  deliveredAt: IsoDateTime,
  conversationId: Schema.optionalKey(ContractId),
}).check(
  Schema.makeFilter((ack) => {
    if (ack.destination === "conversation") {
      return ack.conversationId === undefined
        ? "A conversation delivery names the originating conversation."
        : true;
    }
    return ack.conversationId === undefined ? true : "A dashboard delivery has no conversation id.";
  }),
);
export type DeliveryAckV1 = typeof DeliveryAckV1.Type;

export const deliveryIdFor = (delivery: ResultDeliveryV1): string =>
  `delivery-${delivery.destination}-${delivery.taskId}`;

export const ackFor = (delivery: ResultDeliveryV1): DeliveryAckV1 => ({
  deliveryId: deliveryIdFor(delivery),
  idempotencyKey: delivery.idempotencyKey,
  destination: delivery.destination,
  acceptedRevision: delivery.acceptedRevision,
  deliveredAt: delivery.deliveredAt,
  ...(delivery.conversationId === undefined ? {} : { conversationId: delivery.conversationId }),
});

export const decodeResultDeliveryV1 = Schema.decodeUnknownEffect(ResultDeliveryV1, strictParse);
