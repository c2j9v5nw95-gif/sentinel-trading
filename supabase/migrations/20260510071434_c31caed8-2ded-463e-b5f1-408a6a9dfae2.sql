CREATE OR REPLACE FUNCTION public.manually_close_position(
  _position_id uuid,
  _exit_price numeric,
  _note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pos public.positions%ROWTYPE;
  realized numeric;
  pnl_pct numeric;
BEGIN
  IF NOT public.has_role(auth.uid(), 'operator'::app_role) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO pos FROM public.positions WHERE id = _position_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'position_not_found';
  END IF;
  IF pos.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'position_already_closed';
  END IF;

  IF _exit_price IS NOT NULL AND pos.entry_price IS NOT NULL AND pos.qty_open IS NOT NULL THEN
    IF pos.side = 'long' THEN
      realized := (_exit_price - pos.entry_price) * pos.qty_open;
    ELSE
      realized := (pos.entry_price - _exit_price) * pos.qty_open;
    END IF;
    pnl_pct := CASE WHEN pos.entry_price > 0
      THEN (realized / (pos.entry_price * pos.qty_open)) * 100
      ELSE NULL END;
  ELSE
    realized := COALESCE(pos.realized_pnl, 0);
    pnl_pct := NULL;
  END IF;

  UPDATE public.positions
    SET closed_at = now(),
        qty_open = 0,
        realized_pnl = COALESCE(pos.realized_pnl, 0) + COALESCE(realized - COALESCE(pos.realized_pnl,0), 0),
        protection_state = 'unprotected',
        updated_at = now()
    WHERE id = _position_id;

  -- Use absolute realized (computed) as the new value when exit price provided
  IF _exit_price IS NOT NULL THEN
    UPDATE public.positions SET realized_pnl = realized WHERE id = _position_id;
  END IF;

  INSERT INTO public.position_events(position_id, event_type, detail)
  VALUES (_position_id, 'manual_close', jsonb_build_object(
    'exit_price', _exit_price,
    'realized_pnl', realized,
    'pnl_pct', pnl_pct,
    'note', _note,
    'closed_by', auth.uid(),
    'source', 'manual_ui'
  ));

  INSERT INTO public.audit_log(actor_user_id, action, target, after)
  VALUES (auth.uid(), 'position_manual_close', _position_id::text,
    jsonb_build_object('exit_price', _exit_price, 'realized_pnl', realized, 'pnl_pct', pnl_pct, 'note', _note));

  RETURN jsonb_build_object('ok', true, 'realized_pnl', realized, 'pnl_pct', pnl_pct);
END;
$$;

GRANT EXECUTE ON FUNCTION public.manually_close_position(uuid, numeric, text) TO authenticated;