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
      project_environments: {
        Row: {
          cache_layers: string[]
          created_at: string
          environment_type: string
          hosting_provider: string
          id: string
          name: string
          notes: string
          php_version: string
          primary_url: string
          project_id: string
          updated_at: string
          wordpress_version: string
        }
        Insert: {
          cache_layers?: string[]
          created_at?: string
          environment_type: string
          hosting_provider: string
          id?: string
          name: string
          notes?: string
          php_version: string
          primary_url: string
          project_id: string
          updated_at?: string
          wordpress_version: string
        }
        Update: {
          cache_layers?: string[]
          created_at?: string
          environment_type?: string
          hosting_provider?: string
          id?: string
          name?: string
          notes?: string
          php_version?: string
          primary_url?: string
          project_id?: string
          updated_at?: string
          wordpress_version?: string
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
      project_memory_entries: {
        Row: {
          content: string
          created_at: string
          environment_id: string | null
          id: string
          importance: string
          memory_type: string
          project_id: string
          source_run_id: string | null
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
          source_run_id?: string | null
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
          source_run_id?: string | null
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
      projects: {
        Row: {
          client_name: string
          created_at: string
          environment_health: string
          id: string
          name: string
          organization_id: string
          primary_domain: string
          status: string
          updated_at: string
        }
        Insert: {
          client_name: string
          created_at?: string
          environment_health: string
          id?: string
          name: string
          organization_id: string
          primary_domain: string
          status: string
          updated_at?: string
        }
        Update: {
          client_name?: string
          created_at?: string
          environment_health?: string
          id?: string
          name?: string
          organization_id?: string
          primary_domain?: string
          status?: string
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
      users: {
        Row: {
          created_at: string
          email: string
          full_name: string
          id: string
          organization_id: string
          role: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name: string
          id?: string
          organization_id: string
          role: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          organization_id?: string
          role?: string
          status?: string
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
      current_organization_id: { Args: never; Returns: string }
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
