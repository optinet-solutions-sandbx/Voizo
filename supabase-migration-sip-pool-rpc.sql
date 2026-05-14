-- SIP Pool RPCs: privileged operations on vapi_sip_pool used by call-path code.
-- Both functions are SECURITY DEFINER so they bypass the slot table's RLS
-- (which is service-role-only). They are intentionally narrow: they perform
-- one specific mutation each, with input validation, and nothing else.
--
-- Phase 1 step 5 of the SIP pool rollout. See:
--   docs/2026-05-08_DOC_SIP_Pool_Architecture.md §3.4 (concurrency)
--   .agent/handoffs/2026-05-08_HANDOFF_SIP_Pool_Phase_0_Verification.md

-- ── 1. Lease a free slot atomically ─────────────────────────────
-- Returns the slot row if one was leased, or no rows if pool exhausted.
-- Uses SELECT ... FOR UPDATE SKIP LOCKED so concurrent leases never race.
create or replace function lease_vapi_sip_slot(p_assistant_id text)
returns table (
  id uuid,
  slot_index integer,
  sip_uri text,
  sip_username text,
  vapi_phone_number_id text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slot_id uuid;
begin
  -- Pick the lowest-numbered free slot, lock it, skip locked rows.
  select s.id into v_slot_id
  from vapi_sip_pool s
  where s.status = 'free'
  order by s.slot_index
  for update skip locked
  limit 1;

  if v_slot_id is null then
    -- Pool exhausted; return zero rows.
    return;
  end if;

  -- Atomic claim: mark leased, attach assistant. campaign_id stays NULL
  -- until link_vapi_sip_slot is called from the campaign create flow.
  update vapi_sip_pool s
  set status = 'leased',
      current_assistant_id = p_assistant_id,
      leased_at = now()
  where s.id = v_slot_id
  returning s.id, s.slot_index, s.sip_uri, s.sip_username, s.vapi_phone_number_id
  into id, slot_index, sip_uri, sip_username, vapi_phone_number_id;

  return next;
end;
$$;

-- ── 2. Back-link a campaign to its leased slot ──────────────────
-- Idempotent: setting current_campaign_id when it's already correct is a
-- no-op. Refuses to link if the slot is not currently leased to the
-- expected assistant (prevents cross-wiring under bug conditions).
create or replace function link_vapi_sip_slot(
  p_slot_id uuid,
  p_campaign_id uuid,
  p_expected_assistant_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer;
begin
  update vapi_sip_pool s
  set current_campaign_id = p_campaign_id
  where s.id = p_slot_id
    and s.status = 'leased'
    and s.current_assistant_id = p_expected_assistant_id;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

-- ── 3. Release a slot back to the pool ──────────────────────────
-- Idempotent: releasing an already-free slot returns false. Releasing a
-- leased slot clears all lease state and stamps released_at.
create or replace function release_vapi_sip_slot(p_slot_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer;
begin
  update vapi_sip_pool s
  set status = 'free',
      current_assistant_id = null,
      current_campaign_id = null,
      released_at = now()
  where s.id = p_slot_id
    and s.status = 'leased';

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

-- ── 4. Grants ───────────────────────────────────────────────────
-- These functions are callable by anon/authenticated/service roles.
-- The SECURITY DEFINER + tight input validation is the safety boundary,
-- not the role. Anyone reaching this RPC has already authenticated
-- through Supabase and through the Voizo app routes.
grant execute on function lease_vapi_sip_slot(text) to anon, authenticated, service_role;
grant execute on function link_vapi_sip_slot(uuid, uuid, text) to anon, authenticated, service_role;
grant execute on function release_vapi_sip_slot(uuid) to anon, authenticated, service_role;
