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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      app_settings: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      project_files: {
        Row: {
          created_at: string
          duration_seconds: number | null
          file_name: string
          file_size: number
          file_type: string
          id: string
          mime_type: string
          project_id: string
          status: string
          storage_path: string
          user_id: string
        }
        Insert: {
          created_at?: string
          duration_seconds?: number | null
          file_name: string
          file_size: number
          file_type: string
          id?: string
          mime_type: string
          project_id: string
          status?: string
          storage_path: string
          user_id: string
        }
        Update: {
          created_at?: string
          duration_seconds?: number | null
          file_name?: string
          file_size?: number
          file_type?: string
          id?: string
          mime_type?: string
          project_id?: string
          status?: string
          storage_path?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_files_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          created_at: string
          id: string
          name: string
          status: string
          template_settings: Json
          updated_at: string
          user_id: string
          variation_count: number
          variation_settings: Json
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          status?: string
          template_settings?: Json
          updated_at?: string
          user_id: string
          variation_count?: number
          variation_settings?: Json
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          status?: string
          template_settings?: Json
          updated_at?: string
          user_id?: string
          variation_count?: number
          variation_settings?: Json
        }
        Relationships: []
      }
      render_jobs: {
        Row: {
          attempt_count: number
          completed_at: string | null
          created_at: string
          error_code: string | null
          error_message: string | null
          id: string
          progress: number
          project_id: string
          started_at: string | null
          status: string
          updated_at: string
          user_id: string
          worker_job_id: string | null
        }
        Insert: {
          attempt_count?: number
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          progress?: number
          project_id: string
          started_at?: string | null
          status?: string
          updated_at?: string
          user_id: string
          worker_job_id?: string | null
        }
        Update: {
          attempt_count?: number
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          progress?: number
          project_id?: string
          started_at?: string | null
          status?: string
          updated_at?: string
          user_id?: string
          worker_job_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "render_jobs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      render_output_targets: {
        Row: {
          created_at: string
          file_name: string
          id: string
          mime_type: string
          project_id: string
          render_job_id: string
          source_file_id: string | null
          storage_path: string
          user_id: string
          variation_index: number
          worker_output_id: string
        }
        Insert: {
          created_at?: string
          file_name: string
          id?: string
          mime_type?: string
          project_id: string
          render_job_id: string
          source_file_id?: string | null
          storage_path: string
          user_id: string
          variation_index: number
          worker_output_id: string
        }
        Update: {
          created_at?: string
          file_name?: string
          id?: string
          mime_type?: string
          project_id?: string
          render_job_id?: string
          source_file_id?: string | null
          storage_path?: string
          user_id?: string
          variation_index?: number
          worker_output_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "render_output_targets_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "render_output_targets_render_job_id_fkey"
            columns: ["render_job_id"]
            isOneToOne: false
            referencedRelation: "render_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "render_output_targets_source_file_id_fkey"
            columns: ["source_file_id"]
            isOneToOne: false
            referencedRelation: "project_files"
            referencedColumns: ["id"]
          },
        ]
      }
      render_outputs: {
        Row: {
          checksum: string | null
          created_at: string
          expires_at: string | null
          file_name: string
          file_size: number | null
          id: string
          mime_type: string
          project_id: string
          render_job_id: string
          storage_path: string
          user_id: string
          worker_output_id: string | null
        }
        Insert: {
          checksum?: string | null
          created_at?: string
          expires_at?: string | null
          file_name: string
          file_size?: number | null
          id?: string
          mime_type?: string
          project_id: string
          render_job_id: string
          storage_path: string
          user_id: string
          worker_output_id?: string | null
        }
        Update: {
          checksum?: string | null
          created_at?: string
          expires_at?: string | null
          file_name?: string
          file_size?: number | null
          id?: string
          mime_type?: string
          project_id?: string
          render_job_id?: string
          storage_path?: string
          user_id?: string
          worker_output_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "render_outputs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "render_outputs_render_job_id_fkey"
            columns: ["render_job_id"]
            isOneToOne: false
            referencedRelation: "render_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      rights_confirmations: {
        Row: {
          confirmation_version: string
          id: string
          project_id: string
          rights_confirmed_at: string
          user_id: string
        }
        Insert: {
          confirmation_version: string
          id?: string
          project_id: string
          rights_confirmed_at?: string
          user_id: string
        }
        Update: {
          confirmation_version?: string
          id?: string
          project_id?: string
          rights_confirmed_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rights_confirmations_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_request_nonces: {
        Row: {
          created_at: string
          expires_at: string
          nonce: string
          purpose: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          nonce: string
          purpose: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          nonce?: string
          purpose?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
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
