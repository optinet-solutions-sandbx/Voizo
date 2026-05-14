-- SIP Pool: shift Vapi SIP phone numbers from per-campaign disposable
-- artifacts to a fixed pool of permanent leasable infrastructure.
--
-- Design notes (see docs/2026-05-08_DOC_SIP_Pool_Architecture.md):
--   - Pool size is fixed at N=5 (locked decision D2 2026-05-08).
--     Slots are pre-provisioned on Vapi via scripts/sip-pool-provision.ts
--     and registered here. Pool grows by adding rows + provisioning more
--     numbers; never grows or shrinks at runtime.
--   - Atomicity: lease uses `SELECT ... FOR UPDATE SKIP LOCKED` so two
--     concurrent campaign creates never grab the same slot. Belt-and-suspenders
--     uniqueness via a partial index on (current_campaign_id) where IS NOT NULL.
--   - SIP username constraint: Vapi rejects authentication.username < 20 chars
--     (verified Phase 0 2026-05-08, see verification handoff §3.1). The
--     check constraint here mirrors that rule so a misformed slot row is
--     caught at INSERT time, not at Vapi-call time.
--   - Idle slots: Vapi accepts assistantId=null (verified Phase 0 V2).
--     Released slots PATCH the Vapi phone number with assistantId=null;
--     no placeholder assistant required.
--   - Reversible: drop the new column on campaigns_v2 and the new table.
--     campaigns_v2.vapi_sip_uri is preserved for backward compatibility
--     with existing rows that pre-date the pool.

-- ── 1. SIP pool table ──────────────────────────────────────────
create table vapi_sip_pool (
  id uuid default gen_random_uuid() primary key,

  -- Human-readable slot identity. Used in operator UI and reconciliation.
  slot_index integer not null unique
    check (slot_index between 1 and 999),

  -- SIP routing identity. sip:voizo-sip-pool-slot-NN@sip.vapi.ai
  -- sip_username MUST be >= 20 chars (Vapi rule); enforced here so a
  -- malformed slot is rejected at INSERT, not at Vapi-call time.
  sip_uri text not null unique,
  sip_username text not null unique
    check (length(sip_username) >= 20),

  -- Vapi resource ID for the underlying phone-number resource.
  -- Stored so DELETE / PATCH operations have a direct lookup; without
  -- this, the legacy code path had to GET the full phone-number list
  -- and find-by-assistantId. The new flow needs no list call.
  vapi_phone_number_id text not null unique,

  -- Lifecycle status of the slot.
  --   'free'        : available to lease
  --   'leased'      : currently held by current_campaign_id
  --   'maintenance' : taken out of rotation (operator action / heartbeat
  --                   detected drift; do not auto-lease until cleared)
  status text not null default 'free'
    check (status in ('free', 'leased', 'maintenance')),

  -- Lease state. Both NULL when free; both NOT NULL when leased.
  -- (FK on campaigns_v2 is set null on campaign delete so we don't
  -- block campaign cleanup; the heartbeat reconciliation catches the
  -- "leased but no campaign" case and force-releases.)
  current_assistant_id text,
  current_campaign_id uuid references campaigns_v2(id) on delete set null,

  leased_at timestamptz,
  released_at timestamptz,

  created_at timestamptz default now() not null,
  notes text
);

-- Fast scan for free slots during lease.
create index idx_sip_pool_free on vapi_sip_pool(slot_index)
  where status = 'free';

-- Defensive: a campaign can hold at most one slot at a time.
-- Even if the lease logic regresses, the database refuses the bad write.
create unique index idx_sip_pool_one_lease_per_campaign
  on vapi_sip_pool(current_campaign_id)
  where current_campaign_id is not null;

alter table vapi_sip_pool enable row level security;

-- Service-role only; this is platform infrastructure, not user data.
-- No operator policies are added — all access goes through server-side
-- routes that use SUPABASE_SERVICE_ROLE_KEY.


-- ── 2. campaigns_v2 — link campaigns to leased slots ───────────
-- Nullable: pre-pool campaigns and any future code path that doesn't
-- use the pool will leave this NULL. The existing vapi_sip_uri column
-- continues to be the source of truth for the FreeSWITCH bridge target.
alter table campaigns_v2
  add column vapi_pool_slot_id uuid
    references vapi_sip_pool(id) on delete set null;

create index idx_campaigns_v2_pool_slot
  on campaigns_v2(vapi_pool_slot_id)
  where vapi_pool_slot_id is not null;
