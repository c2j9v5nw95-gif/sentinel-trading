UPDATE public.sizing_rules
SET condition = '{"all":[{"metric":"net_profit","op":"<","value":0}]}',
    label = 'Block if net profit < 0'
WHERE id = 'f4986562-bc40-4510-a95d-73c4f94bad79';