import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

export function Lightbox({ src, onClose }: { src: string | null; onClose: () => void }) {
  return (
    <Dialog open={!!src} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl p-2 bg-background/95">
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-2 top-2 z-10 h-8 w-8 rounded-full bg-background/80"
          onClick={onClose}
          aria-label="Close (Esc)"
        >
          <X className="h-4 w-4" />
        </Button>
        {src && (
          <img
            src={src}
            alt="Full view"
            className="w-full h-auto max-h-[85vh] object-contain rounded"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
