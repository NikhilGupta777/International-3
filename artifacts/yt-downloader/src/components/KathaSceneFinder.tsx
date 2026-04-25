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
    <div className="space-y-4">
      <Toaster richColors position="top-center" />

      {/* Tab header — matches the style of other tabs (Get Subtitles, Timestamps, etc.) */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className="h-10 w-10 rounded-xl flex items-center justify-center text-primary-foreground shrink-0"
            style={{ background: "var(--gradient-warm)", boxShadow: "var(--shadow-warm)" }}
          >
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold tracking-tight">Bhagwat Katha Locator</h2>
            <p className="text-xs text-muted-foreground">AI venue matching from your reference library</p>
          </div>
        </div>
        <Badge variant="secondary">{references.length} images</Badge>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-2 max-w-md">
          <TabsTrigger value="identify">Identify</TabsTrigger>
          <TabsTrigger value="library">Library ({references.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="identify" className="mt-4">
          <IdentifyTab references={references} onOpenLightbox={setLightbox} />
        </TabsContent>

        <TabsContent value="library" className="mt-4 space-y-6">
          <AddReferenceForm onAdded={loadRefs} />
          <LibraryList
            references={references}
            loading={loadingRefs}
            onChanged={loadRefs}
            onOpenLightbox={setLightbox}
          />
        </TabsContent>
      </Tabs>

      <Lightbox src={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}
