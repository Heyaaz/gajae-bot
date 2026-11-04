import { X } from "lucide-react";
import type { FileAttachment } from "../../shared/agent-contract";
import type { ImageAttachment } from "../backend/types";

interface ComposerAttachmentsProps {
  images: ImageAttachment[];
  files: FileAttachment[];
  onRemoveImage: (image: ImageAttachment) => void;
  onRemoveFile: (file: FileAttachment) => void;
}

export function ComposerAttachments({ images, files, onRemoveImage, onRemoveFile }: ComposerAttachmentsProps) {
  return (
    <>
      {images.length > 0 && (
        <div className="composer-images">
          {images.map((image) => (
            <span key={image.id}>
              <img
                src={`data:${image.mimeType};base64,${image.data}`}
                alt={image.name}
              />
              <button
                type="button"
                aria-label={`Remove ${image.name}`}
                onClick={() => onRemoveImage(image)}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="composer-files">
          {files.map((file) => (
            <span className="attachment-chip" key={file.id}>
              <span title={file.label}>{file.label ?? file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => onRemoveFile(file)}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
