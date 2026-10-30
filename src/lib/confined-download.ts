import type { EnqueueTransferInput } from "@/lib/transfer-queue-reducer";
import { pathJoin } from "@/lib/file-entry-types";

/**
 * Download of one server-listed file into a local directory.
 *
 * The name comes from the server, so the transfer goes through the confined
 * command: the backend refuses names containing separators or `..` instead
 * of writing outside `localDir`.
 */
export function confinedFileDownload(
  connectionId: string,
  remoteDir: string,
  localDir: string,
  name: string,
  size: number,
): EnqueueTransferInput {
  return {
    connectionId,
    fileName: name,
    direction: "download",
    sourcePath: pathJoin(remoteDir, name),
    destinationPath: pathJoin(localDir, name),
    totalBytes: size,
    confined: {
      remoteRoot: remoteDir,
      destinationRoot: localDir,
      remoteRelativePath: name,
      destinationRelativePath: name,
    },
  };
}
