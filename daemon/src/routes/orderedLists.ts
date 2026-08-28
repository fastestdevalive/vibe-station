/**
 * GET/PUT /user/ordered-lists/:scopeKey — daemon-persisted, cross-client
 * ordered id lists (pinned-order-sync). `scopeKey` is a generic dimension
 * (Decision 1, `.vibekit/feature-plans/wip/pinned-order-sync/plan-pinned-order-sync.md`)
 * but allowlisted here (Decision 7) so an authenticated client can't grow
 * the table with arbitrary keys. Every query implicitly targets the single
 * implicit 'local' user — see `state/orderedListsStore.ts` and the Scenes
 * PRD's identical "single implicit user, shaped for later" direction.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getOrderedList, setOrderedList } from "../state/orderedListsStore.js";
import { broadcastAll } from "../broadcaster.js";

const ScopeKeyParam = z.object({
  scopeKey: z.enum(["pinned-all"]),
});

const PutOrderedListBody = z.object({
  itemIds: z.array(z.string()).max(500),
});

export function registerOrderedListsRoutes(app: FastifyInstance): void {
  app.get("/user/ordered-lists/:scopeKey", async (req, reply) => {
    const parsedParams = ScopeKeyParam.safeParse(req.params);
    if (!parsedParams.success) {
      return reply.status(400).send({ error: "Validation error", details: parsedParams.error.issues });
    }
    const { scopeKey } = parsedParams.data;
    const { itemIds, updatedAt } = getOrderedList(scopeKey);
    return reply.send({ scopeKey, itemIds, updatedAt });
  });

  app.put("/user/ordered-lists/:scopeKey", async (req, reply) => {
    const parsedParams = ScopeKeyParam.safeParse(req.params);
    if (!parsedParams.success) {
      return reply.status(400).send({ error: "Validation error", details: parsedParams.error.issues });
    }
    const parsedBody = PutOrderedListBody.safeParse(req.body);
    if (!parsedBody.success) {
      return reply.status(400).send({ error: "Validation error", details: parsedBody.error.issues });
    }
    const { scopeKey } = parsedParams.data;
    const { itemIds, updatedAt } = setOrderedList(scopeKey, parsedBody.data.itemIds);
    broadcastAll({ type: "orderedList:updated", scopeKey, itemIds, updatedAt });
    return reply.send({ ok: true, scopeKey, itemIds, updatedAt });
  });
}
