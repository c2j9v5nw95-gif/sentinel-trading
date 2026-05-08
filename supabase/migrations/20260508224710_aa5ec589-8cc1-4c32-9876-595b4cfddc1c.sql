-- Recreate has_role as SECURITY DEFINER with stable search_path
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- Lock down then grant to the right roles
REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, anon, service_role;

-- user_roles must be readable by the function owner; SECURITY DEFINER handles that,
-- but ensure authenticated callers can also read their own roles for client checks.
GRANT SELECT ON public.user_roles TO authenticated;
