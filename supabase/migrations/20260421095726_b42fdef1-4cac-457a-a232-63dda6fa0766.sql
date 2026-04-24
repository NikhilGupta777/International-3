
CREATE TABLE public.katha_references (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  place_name TEXT NOT NULL,
  location TEXT,
  notes TEXT,
  image_url TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.katha_references ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view references" ON public.katha_references FOR SELECT USING (true);
CREATE POLICY "Anyone can insert references" ON public.katha_references FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update references" ON public.katha_references FOR UPDATE USING (true);
CREATE POLICY "Anyone can delete references" ON public.katha_references FOR DELETE USING (true);

INSERT INTO storage.buckets (id, name, public) VALUES ('katha-images', 'katha-images', true);

CREATE POLICY "Public read katha images" ON storage.objects FOR SELECT USING (bucket_id = 'katha-images');
CREATE POLICY "Anyone can upload katha images" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'katha-images');
CREATE POLICY "Anyone can update katha images" ON storage.objects FOR UPDATE USING (bucket_id = 'katha-images');
CREATE POLICY "Anyone can delete katha images" ON storage.objects FOR DELETE USING (bucket_id = 'katha-images');
