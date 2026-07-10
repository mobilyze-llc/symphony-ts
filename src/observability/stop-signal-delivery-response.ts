export interface StopSignalDeliveryResponse {
  status:
    | "not_attempted"
    | "already_exited"
    | "delivered"
    | "partial"
    | "failed";
  reason: string;
  attempted_at: string;
  workspace_path: string | null;
  attempts: Array<{
    pid: number;
    process_group_id?: number;
    sigterm: "delivered" | "already_exited" | "failed";
    sigkill: "delivered" | "already_exited" | "failed" | "not_attempted";
  }>;
  lane_job_id?: string | null;
  lane_cancellation?: {
    state: string;
    killed: boolean;
    failure: string | null;
  };
  lane_cancellations?: Array<{
    lane_job_id: string;
    status: "already_exited" | "delivered" | "failed";
    state: string;
    killed: boolean;
    failure: string | null;
  }>;
  warning: string | null;
}
