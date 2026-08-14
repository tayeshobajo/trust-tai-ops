export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      agent_execution_events: {
        Row: {
          created_at: string
          error_code: string | null
          evidence_data: Json | null
          evidence_refs: Json
          finished_at: string | null
          id: string
          input_summary: string
          invocation_key: string
          output_summary: string
          project_id: string
          risk: string
          run_id: string | null
          started_at: string
          status: string
          tool_id: string
        }
        Insert: {
          created_at?: string
          error_code?: string | null
          evidence_data?: Json | null
          evidence_refs?: Json
          finished_at?: string | null
          id: string
          input_summary?: string
          invocation_key: string
          output_summary?: string
          project_id: string
          risk: string
          run_id?: string | null
          started_at?: string
          status: string
          tool_id: string
        }
        Update: {
          created_at?: string
          error_code?: string | null
          evidence_data?: Json | null
          evidence_refs?: Json
          finished_at?: string | null
          id?: string
          input_summary?: string
          invocation_key?: string
          output_summary?: string
          project_id?: string
          risk?: string
          run_id?: string | null
          started_at?: string
          status?: string
          tool_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_execution_events_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_execution_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_anchors: {
        Row: {
          aliases: string[]
          anchor_type: string
          created_at: string
          id: string
          label: string
          normalized_label: string
          ordinal: number
          project_id: string
          run_id: string | null
          source_message_id: string
          summary: string
        }
        Insert: {
          aliases?: string[]
          anchor_type: string
          created_at?: string
          id?: string
          label: string
          normalized_label: string
          ordinal?: number
          project_id: string
          run_id?: string | null
          source_message_id: string
          summary?: string
        }
        Update: {
          aliases?: string[]
          anchor_type?: string
          created_at?: string
          id?: string
          label?: string
          normalized_label?: string
          ordinal?: number
          project_id?: string
          run_id?: string | null
          source_message_id?: string
          summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_anchors_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_anchors_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_anchors_source_message_id_fkey"
            columns: ["source_message_id"]
            isOneToOne: false
            referencedRelation: "project_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      evidence_analyses: {
        Row: {
          analyzer: string
          created_at: string
          evidence_id: string
          id: string
          model_id: string
          project_id: string
          result: Json
          status: string
          version: number
        }
        Insert: {
          analyzer?: string
          created_at?: string
          evidence_id: string
          id?: string
          model_id?: string
          project_id: string
          result?: Json
          status?: string
          version?: number
        }
        Update: {
          analyzer?: string
          created_at?: string
          evidence_id?: string
          id?: string
          model_id?: string
          project_id?: string
          result?: Json
          status?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "evidence_analyses_evidence_id_fkey"
            columns: ["evidence_id"]
            isOneToOne: false
            referencedRelation: "project_evidence"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evidence_analyses_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_base_entries: {
        Row: {
          created_at: string
          evidence_signals: Json
          host_context: string | null
          id: string
          last_confirmed_at: string
          project_count: number
          resolution: string
          scope: string
          symptom_pattern: string
          task_type: string
          tools_used: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          evidence_signals?: Json
          host_context?: string | null
          id?: string
          last_confirmed_at?: string
          project_count?: number
          resolution: string
          scope?: string
          symptom_pattern: string
          task_type: string
          tools_used?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          evidence_signals?: Json
          host_context?: string | null
          id?: string
          last_confirmed_at?: string
          project_count?: number
          resolution?: string
          scope?: string
          symptom_pattern?: string
          task_type?: string
          tools_used?: Json
          updated_at?: string
        }
        Relationships: []
      }
      memory_candidates: {
        Row: {
          analysis_id: string
          candidate_key: string
          content: string
          created_at: string
          id: string
          importance: string
          kind: string
          memory_type: string
          project_id: string
          provenance: Json
          source_id: string
          status: string
          supersedes_memory_id: string | null
          title: string
        }
        Insert: {
          analysis_id: string
          candidate_key: string
          content?: string
          created_at?: string
          id?: string
          importance?: string
          kind?: string
          memory_type?: string
          project_id: string
          provenance?: Json
          source_id: string
          status?: string
          supersedes_memory_id?: string | null
          title: string
        }
        Update: {
          analysis_id?: string
          candidate_key?: string
          content?: string
          created_at?: string
          id?: string
          importance?: string
          kind?: string
          memory_type?: string
          project_id?: string
          provenance?: Json
          source_id?: string
          status?: string
          supersedes_memory_id?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_candidates_analysis_id_fkey"
            columns: ["analysis_id"]
            isOneToOne: false
            referencedRelation: "source_analyses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_candidates_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_candidates_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "project_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      message_references: {
        Row: {
          anchor_id: string | null
          confidence: number
          created_at: string
          id: string
          label: string
          message_id: string
          project_id: string
          resolution_method: string
          run_id: string | null
          source_message_id: string
          source_run_id: string | null
          summary: string
        }
        Insert: {
          anchor_id?: string | null
          confidence?: number
          created_at?: string
          id?: string
          label?: string
          message_id: string
          project_id: string
          resolution_method: string
          run_id?: string | null
          source_message_id: string
          source_run_id?: string | null
          summary?: string
        }
        Update: {
          anchor_id?: string | null
          confidence?: number
          created_at?: string
          id?: string
          label?: string
          message_id?: string
          project_id?: string
          resolution_method?: string
          run_id?: string | null
          source_message_id?: string
          source_run_id?: string | null
          summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_references_anchor_id_fkey"
            columns: ["anchor_id"]
            isOneToOne: false
            referencedRelation: "conversation_anchors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_references_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "project_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_references_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_references_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_references_source_message_id_fkey"
            columns: ["source_message_id"]
            isOneToOne: false
            referencedRelation: "project_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_references_source_run_id_fkey"
            columns: ["source_run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          descriptor: string
          id: string
          name: string
          subdomain: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          descriptor: string
          id?: string
          name: string
          subdomain: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          descriptor?: string
          id?: string
          name?: string
          subdomain?: string
          updated_at?: string
        }
        Relationships: []
      }
      project_access_methods: {
        Row: {
          access_type: string
          auth_method: string
          created_at: string
          credential_reference: string | null
          environment_id: string | null
          id: string
          label: string
          last_verified_at: string | null
          notes: string
          project_id: string
          status: string
          updated_at: string
        }
        Insert: {
          access_type: string
          auth_method: string
          created_at?: string
          credential_reference?: string | null
          environment_id?: string | null
          id?: string
          label: string
          last_verified_at?: string | null
          notes?: string
          project_id: string
          status: string
          updated_at?: string
        }
        Update: {
          access_type?: string
          auth_method?: string
          created_at?: string
          credential_reference?: string | null
          environment_id?: string | null
          id?: string
          label?: string
          last_verified_at?: string | null
          notes?: string
          project_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_access_methods_environment_id_fkey"
            columns: ["environment_id"]
            isOneToOne: false
            referencedRelation: "project_environments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_access_methods_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_access_secrets: {
        Row: {
          access_type: string
          algorithm: string
          ciphertext: string
          config: Json
          created_at: string
          host_fingerprint: string | null
          id: string
          iv: string
          key_version: string
          last_verified_at: string | null
          project_id: string
          provider: string
          updated_at: string
          username: string
          verification_state: string
        }
        Insert: {
          access_type: string
          algorithm: string
          ciphertext: string
          config?: Json
          created_at?: string
          host_fingerprint?: string | null
          id?: string
          iv: string
          key_version: string
          last_verified_at?: string | null
          project_id: string
          provider: string
          updated_at?: string
          username: string
          verification_state?: string
        }
        Update: {
          access_type?: string
          algorithm?: string
          ciphertext?: string
          config?: Json
          created_at?: string
          host_fingerprint?: string | null
          id?: string
          iv?: string
          key_version?: string
          last_verified_at?: string | null
          project_id?: string
          provider?: string
          updated_at?: string
          username?: string
          verification_state?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_access_secrets_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_environments: {
        Row: {
          cache_layers: string[]
          created_at: string
          environment_type: string
          hosting_provider: string
          id: string
          name: string
          notes: string
          php_version: string | null
          primary_url: string
          project_id: string
          runtime: Json | null
          stack: string
          updated_at: string
          versions: Json
          wordpress_version: string | null
        }
        Insert: {
          cache_layers?: string[]
          created_at?: string
          environment_type: string
          hosting_provider: string
          id?: string
          name: string
          notes?: string
          php_version?: string | null
          primary_url: string
          project_id: string
          runtime?: Json | null
          stack?: string
          updated_at?: string
          versions?: Json
          wordpress_version?: string | null
        }
        Update: {
          cache_layers?: string[]
          created_at?: string
          environment_type?: string
          hosting_provider?: string
          id?: string
          name?: string
          notes?: string
          php_version?: string | null
          primary_url?: string
          project_id?: string
          runtime?: Json | null
          stack?: string
          updated_at?: string
          versions?: Json
          wordpress_version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_environments_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_events: {
        Row: {
          actor_user_id: string | null
          created_at: string
          detail: Json
          event_key: string
          event_type: string
          id: string
          project_id: string
          subject_id: string | null
          summary: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          detail?: Json
          event_key: string
          event_type: string
          id?: string
          project_id: string
          subject_id?: string | null
          summary?: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          detail?: Json
          event_key?: string
          event_type?: string
          id?: string
          project_id?: string
          subject_id?: string | null
          summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_events_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_evidence: {
        Row: {
          analysis_id: string | null
          content_hash: string | null
          created_at: string
          evidence_kind: string
          failure_reason: string | null
          id: string
          intake_key: string | null
          message_id: string | null
          mime_type: string
          original_filename: string
          project_id: string
          run_id: string | null
          safe_filename: string
          size_bytes: number
          status: string
          storage_bucket: string
          storage_path: string
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          analysis_id?: string | null
          content_hash?: string | null
          created_at?: string
          evidence_kind?: string
          failure_reason?: string | null
          id?: string
          intake_key?: string | null
          message_id?: string | null
          mime_type?: string
          original_filename?: string
          project_id: string
          run_id?: string | null
          safe_filename?: string
          size_bytes?: number
          status?: string
          storage_bucket?: string
          storage_path: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          analysis_id?: string | null
          content_hash?: string | null
          created_at?: string
          evidence_kind?: string
          failure_reason?: string | null
          id?: string
          intake_key?: string | null
          message_id?: string | null
          mime_type?: string
          original_filename?: string
          project_id?: string
          run_id?: string | null
          safe_filename?: string
          size_bytes?: number
          status?: string
          storage_bucket?: string
          storage_path?: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_evidence_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "project_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_evidence_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_evidence_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      project_memory_entries: {
        Row: {
          content: string
          created_at: string
          environment_id: string | null
          id: string
          importance: string
          memory_type: string
          project_id: string
          source_candidate_id: string | null
          source_excerpt: string | null
          source_id: string | null
          source_message_id: string | null
          source_run_id: string | null
          superseded_by: string | null
          title: string
          updated_at: string
        }
        Insert: {
          content: string
          created_at?: string
          environment_id?: string | null
          id?: string
          importance: string
          memory_type: string
          project_id: string
          source_candidate_id?: string | null
          source_excerpt?: string | null
          source_id?: string | null
          source_message_id?: string | null
          source_run_id?: string | null
          superseded_by?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          environment_id?: string | null
          id?: string
          importance?: string
          memory_type?: string
          project_id?: string
          source_candidate_id?: string | null
          source_excerpt?: string | null
          source_id?: string | null
          source_message_id?: string | null
          source_run_id?: string | null
          superseded_by?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_memory_entries_environment_id_fkey"
            columns: ["environment_id"]
            isOneToOne: false
            referencedRelation: "project_environments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_memory_entries_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_memory_entries_source_message_id_fkey"
            columns: ["source_message_id"]
            isOneToOne: false
            referencedRelation: "project_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      project_messages: {
        Row: {
          body: string[]
          created_at: string
          dedupe_key: string | null
          id: string
          kind: string
          project_id: string
          role: string
          run_id: string | null
          source_key: string | null
        }
        Insert: {
          body?: string[]
          created_at?: string
          dedupe_key?: string | null
          id?: string
          kind: string
          project_id: string
          role: string
          run_id?: string | null
          source_key?: string | null
        }
        Update: {
          body?: string[]
          created_at?: string
          dedupe_key?: string | null
          id?: string
          kind?: string
          project_id?: string
          role?: string
          run_id?: string | null
          source_key?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_messages_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_messages_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      project_recommendations: {
        Row: {
          category: string
          created_at: string
          id: string
          priority: string
          project_id: string
          run_id: string | null
          status: string
          summary: string
          title: string
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          id?: string
          priority: string
          project_id: string
          run_id?: string | null
          status: string
          summary: string
          title: string
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          priority?: string
          project_id?: string
          run_id?: string | null
          status?: string
          summary?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_recommendations_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_risk_flags: {
        Row: {
          created_at: string
          environment_id: string | null
          id: string
          project_id: string
          severity: string
          status: string
          summary: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          environment_id?: string | null
          id?: string
          project_id: string
          severity: string
          status: string
          summary: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          environment_id?: string | null
          id?: string
          project_id?: string
          severity?: string
          status?: string
          summary?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_risk_flags_environment_id_fkey"
            columns: ["environment_id"]
            isOneToOne: false
            referencedRelation: "project_environments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_risk_flags_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_sources: {
        Row: {
          byte_size: number
          content_hash: string
          created_at: string
          id: string
          normalized_text: string
          occurred_at: string | null
          original_filename: string | null
          processing_status: string
          project_id: string
          raw_ref: string | null
          redaction_report: Json
          source_type: string
          storage_kind: string
          title: string
          uploaded_at: string
          uploaded_by: string | null
        }
        Insert: {
          byte_size?: number
          content_hash: string
          created_at?: string
          id?: string
          normalized_text?: string
          occurred_at?: string | null
          original_filename?: string | null
          processing_status?: string
          project_id: string
          raw_ref?: string | null
          redaction_report?: Json
          source_type?: string
          storage_kind?: string
          title?: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Update: {
          byte_size?: number
          content_hash?: string
          created_at?: string
          id?: string
          normalized_text?: string
          occurred_at?: string | null
          original_filename?: string | null
          processing_status?: string
          project_id?: string
          raw_ref?: string | null
          redaction_report?: Json
          source_type?: string
          storage_kind?: string
          title?: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_sources_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          client_name: string
          created_at: string
          deploy_pipeline: Json | null
          environment_health: string
          id: string
          name: string
          organization_id: string
          primary_domain: string
          status: string
          trust_tai_os_project_id: string | null
          updated_at: string
        }
        Insert: {
          client_name: string
          created_at?: string
          deploy_pipeline?: Json | null
          environment_health: string
          id?: string
          name: string
          organization_id: string
          primary_domain: string
          status: string
          trust_tai_os_project_id?: string | null
          updated_at?: string
        }
        Update: {
          client_name?: string
          created_at?: string
          deploy_pipeline?: Json | null
          environment_health?: string
          id?: string
          name?: string
          organization_id?: string
          primary_domain?: string
          status?: string
          trust_tai_os_project_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      proposed_tasks: {
        Row: {
          access_needed: string[]
          analysis_id: string
          approved_proposal: Json | null
          client_ask: string
          conflict_note: string
          created_at: string
          deadline_text: string
          decided_at: string | null
          decided_by: string | null
          decision_note: string
          depends_on: string[]
          due_at: string | null
          duplicate_of_run_id: string | null
          id: string
          implementation_approach: string
          needs_investigation: boolean
          original_proposal: Json
          owner: string
          project_id: string
          provenance: Json
          related_run_id: string | null
          requires_execution_approval: boolean
          risk_level: string
          run_id: string | null
          source_id: string
          status: string
          task_key: string
          task_type: string
          title: string
          verification_expectation: string
        }
        Insert: {
          access_needed?: string[]
          analysis_id: string
          approved_proposal?: Json | null
          client_ask?: string
          conflict_note?: string
          created_at?: string
          deadline_text?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string
          depends_on?: string[]
          due_at?: string | null
          duplicate_of_run_id?: string | null
          id?: string
          implementation_approach?: string
          needs_investigation?: boolean
          original_proposal?: Json
          owner?: string
          project_id: string
          provenance?: Json
          related_run_id?: string | null
          requires_execution_approval?: boolean
          risk_level?: string
          run_id?: string | null
          source_id: string
          status?: string
          task_key: string
          task_type?: string
          title: string
          verification_expectation?: string
        }
        Update: {
          access_needed?: string[]
          analysis_id?: string
          approved_proposal?: Json | null
          client_ask?: string
          conflict_note?: string
          created_at?: string
          deadline_text?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string
          depends_on?: string[]
          due_at?: string | null
          duplicate_of_run_id?: string | null
          id?: string
          implementation_approach?: string
          needs_investigation?: boolean
          original_proposal?: Json
          owner?: string
          project_id?: string
          provenance?: Json
          related_run_id?: string | null
          requires_execution_approval?: boolean
          risk_level?: string
          run_id?: string | null
          source_id?: string
          status?: string
          task_key?: string
          task_type?: string
          title?: string
          verification_expectation?: string
        }
        Relationships: [
          {
            foreignKeyName: "proposed_tasks_analysis_id_fkey"
            columns: ["analysis_id"]
            isOneToOne: false
            referencedRelation: "source_analyses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposed_tasks_duplicate_of_run_id_fkey"
            columns: ["duplicate_of_run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposed_tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposed_tasks_related_run_id_fkey"
            columns: ["related_run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposed_tasks_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposed_tasks_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "project_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      qa_reports: {
        Row: {
          created_at: string
          id: string
          run_id: string
          summary: string
          unresolved_risks: string[]
          updated_at: string
          verdict: string
        }
        Insert: {
          created_at?: string
          id?: string
          run_id: string
          summary: string
          unresolved_risks?: string[]
          updated_at?: string
          verdict: string
        }
        Update: {
          created_at?: string
          id?: string
          run_id?: string
          summary?: string
          unresolved_risks?: string[]
          updated_at?: string
          verdict?: string
        }
        Relationships: [
          {
            foreignKeyName: "qa_reports_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      qa_results: {
        Row: {
          created_at: string
          id: string
          name: string
          notes: string
          qa_report_id: string
          qa_rule_id: string | null
          result: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          notes: string
          qa_report_id: string
          qa_rule_id?: string | null
          result: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          notes?: string
          qa_report_id?: string
          qa_rule_id?: string | null
          result?: string
        }
        Relationships: [
          {
            foreignKeyName: "qa_results_qa_report_id_fkey"
            columns: ["qa_report_id"]
            isOneToOne: false
            referencedRelation: "qa_reports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qa_results_qa_rule_id_fkey"
            columns: ["qa_rule_id"]
            isOneToOne: false
            referencedRelation: "qa_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      qa_rules: {
        Row: {
          created_at: string
          description: string
          environment_id: string | null
          id: string
          name: string
          project_id: string
          required: boolean
          rule_type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description: string
          environment_id?: string | null
          id?: string
          name: string
          project_id: string
          required?: boolean
          rule_type: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string
          environment_id?: string | null
          id?: string
          name?: string
          project_id?: string
          required?: boolean
          rule_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "qa_rules_environment_id_fkey"
            columns: ["environment_id"]
            isOneToOne: false
            referencedRelation: "project_environments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qa_rules_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      run_actions: {
        Row: {
          actor: string
          created_at: string
          id: string
          outcome: string
          run_id: string
          summary: string
        }
        Insert: {
          actor: string
          created_at?: string
          id?: string
          outcome: string
          run_id: string
          summary: string
        }
        Update: {
          actor?: string
          created_at?: string
          id?: string
          outcome?: string
          run_id?: string
          summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_actions_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      run_approvals: {
        Row: {
          approval_type: string
          approved_by_user_id: string | null
          created_at: string
          decided_at: string | null
          id: string
          reason: string
          run_id: string
          status: string
        }
        Insert: {
          approval_type: string
          approved_by_user_id?: string | null
          created_at?: string
          decided_at?: string | null
          id?: string
          reason: string
          run_id: string
          status: string
        }
        Update: {
          approval_type?: string
          approved_by_user_id?: string | null
          created_at?: string
          decided_at?: string | null
          id?: string
          reason?: string
          run_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_approvals_approved_by_user_id_fkey"
            columns: ["approved_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "run_approvals_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      run_artifacts: {
        Row: {
          artifact_type: string
          created_at: string
          id: string
          run_id: string
          storage_ref: string | null
          summary: string
          title: string
        }
        Insert: {
          artifact_type: string
          created_at?: string
          id?: string
          run_id: string
          storage_ref?: string | null
          summary: string
          title: string
        }
        Update: {
          artifact_type?: string
          created_at?: string
          id?: string
          run_id?: string
          storage_ref?: string | null
          summary?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_artifacts_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      run_findings: {
        Row: {
          created_at: string
          id: string
          run_id: string
          severity: string
          summary: string
          title: string
        }
        Insert: {
          created_at?: string
          id?: string
          run_id: string
          severity: string
          summary: string
          title: string
        }
        Update: {
          created_at?: string
          id?: string
          run_id?: string
          severity?: string
          summary?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_findings_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      run_phases: {
        Row: {
          created_at: string
          id: string
          label: string
          run_id: string
          state: string
          status: string
          summary: string
        }
        Insert: {
          created_at?: string
          id?: string
          label: string
          run_id: string
          state: string
          status: string
          summary: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string
          run_id?: string
          state?: string
          status?: string
          summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_phases_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      run_plans: {
        Row: {
          created_at: string
          goal: string
          hypotheses: Json
          id: string
          project_id: string
          revision: number
          run_id: string
          steps: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          goal?: string
          hypotheses?: Json
          id?: string
          project_id: string
          revision?: number
          run_id: string
          steps?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          goal?: string
          hypotheses?: Json
          id?: string
          project_id?: string
          revision?: number
          run_id?: string
          steps?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_plans_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "run_plans_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      run_recommendations: {
        Row: {
          category: string
          created_at: string
          id: string
          priority: string
          run_id: string
          status: string
          summary: string
          title: string
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          id?: string
          priority: string
          run_id: string
          status: string
          summary: string
          title: string
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          priority?: string
          run_id?: string
          status?: string
          summary?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_recommendations_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      runs: {
        Row: {
          approval_required: boolean
          backup_status: string
          completed_at: string | null
          created_at: string
          created_by_user_id: string | null
          diagnosis_summary: string
          environment_id: string
          id: string
          next_action: string
          operator_prompt: string
          origin_proposed_task_id: string | null
          origin_source_id: string | null
          plan_summary: string
          project_id: string
          risk_level: string
          started_at: string
          state: string
          task_summary: string
          task_type: string
          title: string
          updated_at: string
          urgency: string
        }
        Insert: {
          approval_required?: boolean
          backup_status: string
          completed_at?: string | null
          created_at?: string
          created_by_user_id?: string | null
          diagnosis_summary?: string
          environment_id: string
          id?: string
          next_action: string
          operator_prompt: string
          origin_proposed_task_id?: string | null
          origin_source_id?: string | null
          plan_summary?: string
          project_id: string
          risk_level: string
          started_at?: string
          state: string
          task_summary: string
          task_type: string
          title: string
          updated_at?: string
          urgency: string
        }
        Update: {
          approval_required?: boolean
          backup_status?: string
          completed_at?: string | null
          created_at?: string
          created_by_user_id?: string | null
          diagnosis_summary?: string
          environment_id?: string
          id?: string
          next_action?: string
          operator_prompt?: string
          origin_proposed_task_id?: string | null
          origin_source_id?: string | null
          plan_summary?: string
          project_id?: string
          risk_level?: string
          started_at?: string
          state?: string
          task_summary?: string
          task_type?: string
          title?: string
          updated_at?: string
          urgency?: string
        }
        Relationships: [
          {
            foreignKeyName: "runs_created_by_user_id_fkey"
            columns: ["created_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "runs_environment_id_fkey"
            columns: ["environment_id"]
            isOneToOne: false
            referencedRelation: "project_environments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "runs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      source_analyses: {
        Row: {
          context_hash: string
          coverage: Json
          created_at: string
          id: string
          mode: string
          model_id: string
          project_id: string
          prompt_version: string
          result: Json
          source_id: string
          status: string
          version: number
          window_count: number
        }
        Insert: {
          context_hash?: string
          coverage?: Json
          created_at?: string
          id?: string
          mode?: string
          model_id?: string
          project_id: string
          prompt_version?: string
          result?: Json
          source_id: string
          status?: string
          version?: number
          window_count?: number
        }
        Update: {
          context_hash?: string
          coverage?: Json
          created_at?: string
          id?: string
          mode?: string
          model_id?: string
          project_id?: string
          prompt_version?: string
          result?: Json
          source_id?: string
          status?: string
          version?: number
          window_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "source_analyses_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_analyses_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "project_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          auth_user_id: string | null
          created_at: string
          email: string
          full_name: string
          id: string
          organization_id: string
          role: string
          status: string
          trust_tai_os_user_id: string | null
          updated_at: string
        }
        Insert: {
          auth_user_id?: string | null
          created_at?: string
          email: string
          full_name: string
          id?: string
          organization_id: string
          role: string
          status?: string
          trust_tai_os_user_id?: string | null
          updated_at?: string
        }
        Update: {
          auth_user_id?: string | null
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          organization_id?: string
          role?: string
          status?: string
          trust_tai_os_user_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "users_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      auth_email: { Args: never; Returns: string }
      auth_role: { Args: never; Returns: string }
      can_approve_ops: { Args: never; Returns: boolean }
      can_write_ops: { Args: never; Returns: boolean }
      meeting_approve_proposal: {
        Args: {
          _actor: string
          _approved_proposal: Json
          _phases: Json
          _proposal_id: string
          _run: Json
        }
        Returns: string
      }
      meeting_decide_memory_candidate: {
        Args: { _accepted: boolean; _actor: string; _candidate_id: string }
        Returns: string
      }
      meeting_record_event: {
        Args: {
          _actor: string
          _detail: Json
          _event_key: string
          _event_type: string
          _project_id: string
          _subject: string
          _summary: string
        }
        Returns: undefined
      }
      meeting_reject_proposal: {
        Args: { _actor: string; _note: string; _proposal_id: string }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
