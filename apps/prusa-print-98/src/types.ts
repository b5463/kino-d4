export type Port = {
  device: string;
  description: string;
  manufacturer?: string | null;
  vid?: number | null;
  pid?: number | null;
  serialNumber?: string | null;
  isPrusa: boolean;
};

export type Issue = {
  id: string;
  severity: 'advisory' | 'warning' | 'error';
  title: string;
  detail: string;
  fix: string;
};

export type GCodeInfo = {
  path: string;
  name: string;
  size_bytes: number;
  printer_model: string;
  printer_profile: string;
  filament_type: string;
  filament_grams: string;
  estimated_time: string;
  nozzle_temperature: string;
  bed_temperature: string;
  nozzle_diameter: string;
  command_count: number;
  total_layers: number;
  issues: Issue[];
  recommendedNozzle: number;
  recommendedAntiOoze: boolean;
  safeToPrint: boolean;
};

export type PrintState = {
  status: string;
  message: string;
  progress?: number;
  hotend?: number | null;
  hotend_target?: number | null;
  bed?: number | null;
  bed_target?: number | null;
  file_name?: string;
  commands_sent?: number;
  commands_total?: number;
  started_at?: string;
  completed_at?: string;
  worker_version?: string;
  phase?: string;
  nozzle_interlock?: 'locked' | 'ready';
  remaining_minutes?: number | null;
  firmware_progress?: number | null;
  current_layer?: number;
  total_layers?: number;
  layer_z?: number | null;
  firmware?: string;
  machine_type?: string;
  port?: string;
  baud?: number;
  hotend_power?: number | null;
  bed_power?: number | null;
  fan_percent?: number | null;
  speed_percent?: number | null;
  flow_percent?: number | null;
  position_x?: number | null;
  position_y?: number | null;
  position_z?: number | null;
};

declare global {
  interface Window {
    kinoPrint: {
      openFile(): Promise<string | null>;
      getDroppedFilePath(file: File): string;
      inspectFile(path: string): Promise<GCodeInfo>;
      listPorts(): Promise<Port[]>;
      startPrint(request: { port: string; file: string; nozzleTemp: number; antiOoze: boolean }): Promise<{ ok: boolean; pid: number }>;
      sendControl(action: 'pause' | 'resume' | 'stop'): Promise<{ ok: boolean }>;
      emergencyCooldown(): Promise<{ ok: boolean; port: string; reply: string }>;
      acknowledgePowerOff(): Promise<{ ok: boolean }>;
      getStatus(): Promise<PrintState>;
      showLog(): Promise<string>;
      showUserGuide(): Promise<void>;
      closeWindow(): Promise<void>;
      minimizeWindow(): Promise<void>;
      maximizeWindow(): Promise<void>;
    };
  }
}
