import type { DeviceId, ProjectId } from "../lib/collaboration/identities.ts";
import type { PortableBatchId } from "../lib/collaboration/hc2/identities.ts";
import {
  deriveHc2MutationLockName,
  type Hc2FolderReconstruction,
  type Hc2PortableMutationResult,
  type Hc2StorageFailureCut
} from "../lib/collaboration/hc2/index.ts";

declare const project: ProjectId;
declare const device: DeviceId;
declare const batch: PortableBatchId;

const lockName: string = deriveHc2MutationLockName(project, device);
const cut: Hc2StorageFailureCut = "after_folder_commit_before_indexeddb_finalization";
const reconstruction: Hc2FolderReconstruction = {
  status: "verified",
  frontier_batch_id: batch,
  visible_batch_ids: [batch],
  object_ids: [],
  can_resume_existing_device_authoring: false,
  recovery_requirement: "new_device_or_recovery_required",
  diagnostics: []
};
const result: Hc2PortableMutationResult = {
  status: "committed",
  batch_id: batch,
  reconstruction,
  reservation_status: "advanced",
  finalization_status: "finalized"
};

// @ts-expect-error lock identity inputs must be branded and strictly parsed.
deriveHc2MutationLockName("project", "device");
// @ts-expect-error folder reconstruction can never authorize an old device.
reconstruction.can_resume_existing_device_authoring = true;
// @ts-expect-error generic booleans are not mutation outcomes.
const invalidResult: Hc2PortableMutationResult = true;

void [lockName, cut, result, invalidResult];
