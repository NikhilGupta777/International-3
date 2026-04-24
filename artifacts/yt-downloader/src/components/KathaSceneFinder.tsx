import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { Reference } from "@/lib/katha-types";
import { IdentifyTab } from "@/components/katha/IdentifyTab";
import { AddReferenceForm } from "@/components/katha/AddReferenceForm";
import { LibraryList } from "@/components/katha/LibraryList";
import { Lightbox } from "@/components/katha/Lightbox";

export function KathaSceneFinder() {
  const [tab, setTab] = useState("identify");
  const [references, setReferences] = useState<Reference[]>([]);
  const [loadingRefs, setLoadingRefs] = useState(true);
  const [lightbox, setLightbox] = useState<string | null>(null);

  async function loadRefs() {
    setLoadingRefs(true);
    const { data, error } = await supabase
      .from("katha_references")
      .select("*")
      .order("place_name", { ascending: true })
      .order("created_at", { ascending: false });
    if (error) toast.error("Failed to load: " + error.message);
    else setReferences(data || []);
    setLoadingRefs(false);
  }

  useEffect(() => { loadRefs(); }, []);

  return (
    <div className="min-h-screen" style={{ background: "var(--gradient-soft)" }}>
      <Toaster richColors position="top-center" />

      <header className="border-b border-border/50 backdrop-blur bg-background/70 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-3">
          <div
            className="h-10 w-10 rounded-xl flex items-center justify-center text-primary-foreground shrink-0"
            style={{ background: "var(--gradient-warm)", boxShadow: "var(--shadow-warm)" }}
          >
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold tracking-tight truncate">Bhagwat Katha Locator</h1>
            <p className="text-xs text-muted-foreground">AI venue matching from your reference library</p>
          </div>
          <Badge variant="secondary" className="hidden sm:inline-flex">{references.length} images</Badge>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-2 max-w-md">
            <TabsTrigger value="identify">Identify</TabsTrigger>
            <TabsTrigger value="library">Library ({references.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="identify" className="mt-6">
            <IdentifyTab references={references} onOpenLightbox={setLightbox} />
          </TabsContent>

          <TabsContent value="library" className="mt-6 space-y-6">
            <AddReferenceForm onAdded={loadRefs} />
            <LibraryList
              references={references}
              loading={loadingRefs}
              onChanged={loadRefs}
              onOpenLightbox={setLightbox}
            />
          </TabsContent>
        </Tabs>
      </main>

      <Lightbox src={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}

