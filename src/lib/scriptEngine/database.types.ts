// Focused Supabase types for the Script Engine — just the 8+1 tables the ported
// runtime touches (plan §1.2 / supabase-migration-script-engine.sql). Voizo's
// app-wide client is untyped and has no generated Database type, so the engine
// carries its own narrow one. Row/Insert/Update shapes are transcribed verbatim
// from the source repo's lib/database.types.ts so the ported lab-*.ts compile
// unchanged.

export type Database = {
  public: {
    Tables: {
      listener_handlers: {
        Row: {
          id: string;
          name: string;
          intent_key: string;
          description: string;
          response_template: string;
          action_type: "answer" | "send_sms" | "give_offer" | "end_call" | "ignore";
          delivery: "verbatim" | "reword";
          group_name: string;
          tags: string[];
          enabled: boolean;
          priority: number;
          mode: "tool" | "listener" | "both";
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          intent_key: string;
          description?: string;
          response_template?: string;
          action_type?: "answer" | "send_sms" | "give_offer" | "end_call" | "ignore";
          delivery?: "verbatim" | "reword";
          group_name?: string;
          tags?: string[];
          enabled?: boolean;
          priority?: number;
          mode?: "tool" | "listener" | "both";
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          intent_key?: string;
          description?: string;
          response_template?: string;
          action_type?: "answer" | "send_sms" | "give_offer" | "end_call" | "ignore";
          delivery?: "verbatim" | "reword";
          group_name?: string;
          tags?: string[];
          enabled?: boolean;
          priority?: number;
          mode?: "tool" | "listener" | "both";
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      lab_call_events: {
        Row: {
          id: number;
          call_id: string;
          event_type: string;
          role: string | null;
          content: string | null;
          intent_key: string | null;
          confidence: number | null;
          handler_id: string | null;
          action_type: string | null;
          utterance_at: string | null;
          received_at: string;
          classified_at: string | null;
          injected_at: string | null;
          latency_ms: number | null;
          meta: Record<string, unknown> | null;
          created_at: string;
        };
        Insert: {
          id?: number;
          call_id: string;
          event_type: string;
          role?: string | null;
          content?: string | null;
          intent_key?: string | null;
          confidence?: number | null;
          handler_id?: string | null;
          action_type?: string | null;
          utterance_at?: string | null;
          received_at?: string;
          classified_at?: string | null;
          injected_at?: string | null;
          latency_ms?: number | null;
          meta?: Record<string, unknown> | null;
          created_at?: string;
        };
        Update: {
          id?: number;
          call_id?: string;
          event_type?: string;
          role?: string | null;
          content?: string | null;
          intent_key?: string | null;
          confidence?: number | null;
          handler_id?: string | null;
          action_type?: string | null;
          utterance_at?: string | null;
          received_at?: string;
          classified_at?: string | null;
          injected_at?: string | null;
          latency_ms?: number | null;
          meta?: Record<string, unknown> | null;
          created_at?: string;
        };
        Relationships: [];
      };
      lab_settings: {
        Row: {
          id: string;
          lab_assistant_id: string | null;
          short_prompt: string | null;
          router_model: string;
          confidence_threshold: number;
          injection_cooldown_ms: number;
          trigger_response: boolean;
          server_url_override: string | null;
          active_collection_id: string | null;
          active_script_id: string | null;
          updated_at: string;
        };
        Insert: {
          id?: string;
          lab_assistant_id?: string | null;
          short_prompt?: string | null;
          router_model?: string;
          confidence_threshold?: number;
          injection_cooldown_ms?: number;
          trigger_response?: boolean;
          server_url_override?: string | null;
          active_collection_id?: string | null;
          active_script_id?: string | null;
          updated_at?: string;
        };
        Update: {
          id?: string;
          lab_assistant_id?: string | null;
          short_prompt?: string | null;
          router_model?: string;
          confidence_threshold?: number;
          injection_cooldown_ms?: number;
          trigger_response?: boolean;
          server_url_override?: string | null;
          active_collection_id?: string | null;
          active_script_id?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      listener_collections: {
        Row: {
          id: string;
          name: string;
          description: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          description?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          description?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      listener_collection_handlers: {
        Row: {
          collection_id: string;
          handler_id: string;
        };
        Insert: {
          collection_id: string;
          handler_id: string;
        };
        Update: {
          collection_id?: string;
          handler_id?: string;
        };
        Relationships: [];
      };
      listener_scripts: {
        Row: {
          id: string;
          name: string;
          description: string;
          collection_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          description?: string;
          collection_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          description?: string;
          collection_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      listener_script_nodes: {
        Row: {
          id: string;
          script_id: string;
          type: string;
          scenario_id: string | null;
          label: string;
          config: Record<string, unknown>;
          pos_x: number;
          pos_y: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          script_id: string;
          type: string;
          scenario_id?: string | null;
          label?: string;
          config?: Record<string, unknown>;
          pos_x?: number;
          pos_y?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          script_id?: string;
          type?: string;
          scenario_id?: string | null;
          label?: string;
          config?: Record<string, unknown>;
          pos_x?: number;
          pos_y?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      listener_script_edges: {
        Row: {
          id: string;
          script_id: string;
          source_node_id: string;
          target_node_id: string;
          condition: Record<string, unknown>;
          label: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          script_id: string;
          source_node_id: string;
          target_node_id: string;
          condition?: Record<string, unknown>;
          label?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          script_id?: string;
          source_node_id?: string;
          target_node_id?: string;
          condition?: Record<string, unknown>;
          label?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      lab_call_flow_state: {
        Row: {
          call_id: string;
          script_id: string | null;
          current_node_id: string | null;
          variables: Record<string, unknown>;
          updated_at: string;
        };
        Insert: {
          call_id: string;
          script_id?: string | null;
          current_node_id?: string | null;
          variables?: Record<string, unknown>;
          updated_at?: string;
        };
        Update: {
          call_id?: string;
          script_id?: string | null;
          current_node_id?: string | null;
          variables?: Record<string, unknown>;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

export type ListenerHandler = Database["public"]["Tables"]["listener_handlers"]["Row"];
export type LabCallEvent = Database["public"]["Tables"]["lab_call_events"]["Row"];
export type LabSettings = Database["public"]["Tables"]["lab_settings"]["Row"];
export type ListenerCollection = Database["public"]["Tables"]["listener_collections"]["Row"];
export type ListenerCollectionHandler = Database["public"]["Tables"]["listener_collection_handlers"]["Row"];
export type ListenerScript = Database["public"]["Tables"]["listener_scripts"]["Row"];
export type ListenerScriptNode = Database["public"]["Tables"]["listener_script_nodes"]["Row"];
export type ListenerScriptEdge = Database["public"]["Tables"]["listener_script_edges"]["Row"];
export type LabCallFlowState = Database["public"]["Tables"]["lab_call_flow_state"]["Row"];
