
-- has_role: only used internally by RLS policies, not callable directly
revoke execute on function public.has_role(uuid, app_role) from anon, authenticated, public;

-- touch_updated_at: pin search_path
create or replace function public.touch_updated_at()
returns trigger language plpgsql
set search_path = public
as $$
begin new.updated_at = now(); return new; end $$;
