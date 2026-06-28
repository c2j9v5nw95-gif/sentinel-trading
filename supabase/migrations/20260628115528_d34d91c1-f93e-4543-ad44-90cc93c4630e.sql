
CREATE POLICY "owners read backtest screenshots"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'backtest-screenshots' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "owners upload backtest screenshots"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'backtest-screenshots' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "owners update backtest screenshots"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'backtest-screenshots' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'backtest-screenshots' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "owners delete backtest screenshots"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'backtest-screenshots' AND (storage.foldername(name))[1] = auth.uid()::text);
