import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, MapPin, Search, Pencil, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Reference, BUCKET } from "@/lib/katha-types";

type SortKey = "name" | "newest" | "count";

interface Props {
  references: Reference[];
  loading: boolean;
  onChanged: () => void;
  onOpenLightbox: (src: string) => void;
}

export function LibraryList({ references, loading, onChanged, onOpenLightbox }: Props) {
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("name");
  const [editingPlace, setEditingPlace] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editLocation, setEditLocation] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [deletePlace, setDeletePlace] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const g: Record<string, Reference[]> = {};
    for (const r of references) (g[r.place_name] ||= []).push(r);
    return g;
  }, [references]);

  const filteredPlaces = useMemo(() => {
    const q = search.trim().toLowerCase();
    let entries = Object.entries(grouped);
    if (q) {
      entries = entries.filter(([place, items]) =>
        place.toLowerCase().includes(q)
        || items.some((i) => (i.location || "").toLowerCase().includes(q))
        || items.some((i) => (i.notes || "").toLowerCase().includes(q))
      );
    }
    entries.sort(([aPlace, aItems], [bPlace, bItems]) => {
      if (sortBy === "name") return aPlace.localeCompare(bPlace);
      if (sortBy === "count") return bItems.length - aItems.length;
      // newest
      const aMax = Math.max(...aItems.map((i) => +new Date(i.created_at)));
      const bMax = Math.max(...bItems.map((i) => +new Date(i.created_at)));
      return bMax - aMax;
    });
    return entries;
  }, [grouped, search, sortBy]);

  async function deleteOne(r: Reference) {
    await supabase.storage.from(BUCKET).remove([r.storage_path]);
    const { error } = await supabase.from("katha_references").delete().eq("id", r.id);
    if (error) toast.error(error.message);
    else { toast.success("Image deleted"); onChanged(); }
  }

  async function deleteWholePlace(place: string) {
    const items = references.filter((r) => r.place_name === place);
    const paths = items.map((r) => r.storage_path);
    if (paths.length) await supabase.storage.from(BUCKET).remove(paths);
    const { error } = await supabase.from("katha_references").delete().eq("place_name", place);
    if (error) toast.error(error.message);
    else { toast.success(`Deleted "${place}" and ${items.length} image(s)`); onChanged(); }
    setDeletePlace(null);
  }

  function startEditPlace(place: string) {
    const items = references.filter((r) => r.place_name === place);
    setEditingPlace(place);
    setEditName(place);
    setEditLocation(items[0]?.location || "");
    setEditNotes(items[0]?.notes || "");
  }

  async function saveEditPlace() {
    if (!editingPlace || !editName.trim()) return;
    const { error } = await supabase
      .from("katha_references")
      .update({
        place_name: editName.trim(),
        location: editLocation.trim() || null,
        notes: editNotes.trim() || null,
      })
      .eq("place_name", editingPlace);
    if (error) toast.error(error.message);
    else { toast.success("Updated"); setEditingPlace(null); onChanged(); }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-lg font-semibold">
          Saved places ({Object.keys(grouped).length})
        </h2>
        <div className="flex gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-64">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search places…"
              className="pl-8 pr-8"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortKey)}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="name">Name</SelectItem>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="count">Most images</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filteredPlaces.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {references.length === 0 ? "No references yet. Add some above." : "No matches for that search."}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredPlaces.map(([place, items]) => (
            <Card key={place}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="min-w-0">
                    <CardTitle className="text-base">{place}</CardTitle>
                    {items[0].location && (
                      <CardDescription className="flex items-center gap-1">
                        <MapPin className="h-3 w-3" />{items[0].location}
                      </CardDescription>
                    )}
                    {items[0].notes && <p className="text-xs text-muted-foreground mt-1">{items[0].notes}</p>}
                  </div>
                  <div className="flex gap-1">
                    <Badge variant="secondary">{items.length} img</Badge>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEditPlace(place)} aria-label="Edit">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => setDeletePlace(place)} aria-label="Delete place">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-2">
                  {items.map((r) => (
                    <div key={r.id} className="relative group aspect-square">
                      <button onClick={() => onOpenLightbox(r.image_url)} className="block w-full h-full">
                        <img
                          src={r.image_url}
                          alt={r.place_name}
                          loading="lazy"
                          decoding="async"
                          className="w-full h-full object-cover rounded-md"
                        />
                      </button>
                      <button
                        onClick={() => deleteOne(r)}
                        className="absolute top-1 right-1 h-6 w-6 rounded-md bg-destructive/90 text-destructive-foreground opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity flex items-center justify-center"
                        aria-label="Delete image"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!editingPlace} onOpenChange={(o) => !o && setEditingPlace(null)}>
        <DialogContent className="max-w-md">
          <h3 className="font-semibold text-lg mb-2">Edit place</h3>
          <p className="text-xs text-muted-foreground mb-4">Updates apply to all images of this place.</p>
          <div className="space-y-3">
            <div>
              <Label>Place name</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div>
              <Label>Location</Label>
              <Input value={editLocation} onChange={(e) => setEditLocation(e.target.value)} />
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} rows={2} />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setEditingPlace(null)}>Cancel</Button>
              <Button onClick={saveEditPlace} style={{ background: "var(--gradient-warm)" }}>Save</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deletePlace} onOpenChange={(o) => !o && setDeletePlace(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deletePlace}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes all images for this place. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletePlace && deleteWholePlace(deletePlace)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
