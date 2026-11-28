import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Upload } from "lucide-react";
import { useFileDrop } from "@/lib/dialogs";
import { useIngestStore, useSettingsStore, useUiStore } from "@/stores";
import type { Uuid } from "@/types/contracts";
import { FolderPickerDialog } from "./FolderPickerDialog";

/**
 * App-wide file drag & drop handler (covers the 3D Brain and all general views
 * that don't own a specialized drop target like Library, Theme Store, or Tools → Importer).
 * Shows the "¿Dónde guardarlo?" folder picker before calling `ingest_paths`.
 */
export function DropIngestHost() {
  const { t } = useTranslation();
  const activeNav = useUiStore((s) => s.activeNav);
  const toolsTab = useUiStore((s) => s.toolsTab);
  const readOnly = useSettingsStore((s) => s.settings.read_only);
  const startIngestPaths = useIngestStore((s) => s.startIngestPaths);

  const [pendingPaths, setPendingPaths] = useState<string[] | null>(null);

  const handlesOwnDrop =
    activeNav === "library" ||
    activeNav === "store" ||
    (activeNav === "tools" && toolsTab === "importer");

  const dropEnabled = !readOnly && !handlesOwnDrop && pendingPaths === null;

  const handleDropPaths = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setPendingPaths(paths);
  }, []);

  const { isDragging } = useFileDrop(handleDropPaths, dropEnabled);

  const handleConfirmDestination = useCallback(
    (projectId: Uuid | null) => {
      if (!pendingPaths || pendingPaths.length === 0) {
        setPendingPaths(null);
        return;
      }
      const paths = [...pendingPaths];
      setPendingPaths(null);
      void startIngestPaths({
        paths,
        project_id: projectId,
        watch: false,
        mark_reusable: false,
        ocr: true,
      });
    },
    [pendingPaths, startIngestPaths],
  );

  return (
    <>
      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-void/75 backdrop-blur-xs">
          <div className="flex flex-col items-center gap-2.5 rounded-[2px] border-2 border-dashed border-cobalt bg-cobalt-wash/90 px-8 py-6 text-center">
            <Upload size={26} className="text-cobalt-ink" aria-hidden />
            <div className="text-base font-semibold tracking-tight text-bone">
              {t("brain.dropToIngestTitle")}
            </div>
            <p className="text-xs text-bone-muted">{t("brain.dropToIngestHint")}</p>
          </div>
        </div>
      )}

      {pendingPaths && (
        <FolderPickerDialog
          mode="drop"
          droppedPaths={pendingPaths}
          onConfirm={handleConfirmDestination}
          onCancel={() => setPendingPaths(null)}
        />
      )}
    </>
  );
}
