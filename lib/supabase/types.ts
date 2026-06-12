// Hand-written Database types mirroring supabase/migrations/20260612120000_initial_schema.sql.
// If the schema changes, update this file in the same commit as the migration.
// (Can later be replaced by `supabase gen types typescript` output — same shape.)

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      users: {
        Row: {
          id: string;
          email: string;
          testing_email: string;
          display_name: string;
          country: string;
          avatar_url: string | null;
          role: Database["public"]["Enums"]["user_role"];
          reliability_score: number;
          is_founding_member: boolean;
          onboarded_at: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          email: string;
          testing_email: string;
          display_name: string;
          country?: string;
          avatar_url?: string | null;
          role?: Database["public"]["Enums"]["user_role"];
          reliability_score?: number;
          is_founding_member?: boolean;
          onboarded_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          testing_email?: string;
          display_name?: string;
          country?: string;
          avatar_url?: string | null;
          role?: Database["public"]["Enums"]["user_role"];
          reliability_score?: number;
          is_founding_member?: boolean;
          onboarded_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      devices: {
        Row: {
          id: string;
          user_id: string;
          manufacturer: string;
          model: string;
          android_version: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          manufacturer: string;
          model: string;
          android_version: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          manufacturer?: string;
          model?: string;
          android_version?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      test_requests: {
        Row: {
          id: string;
          owner_id: string;
          app_name: string;
          package_name: string;
          description: string;
          category: Database["public"]["Enums"]["request_category"];
          join_method: Database["public"]["Enums"]["join_method"];
          opt_in_url: string;
          group_url: string | null;
          instructions: string;
          min_android_version: number;
          slots_needed: number;
          status: Database["public"]["Enums"]["request_status"];
          streak_days: number;
          clock_started_at: string | null;
          is_founding: boolean;
          icon_url: string | null;
          screenshots: Json | null;
          created_at: string;
          published_at: string | null;
        };
        Insert: {
          id?: string;
          owner_id: string;
          app_name: string;
          package_name: string;
          description: string;
          category: Database["public"]["Enums"]["request_category"];
          join_method: Database["public"]["Enums"]["join_method"];
          opt_in_url: string;
          group_url?: string | null;
          instructions: string;
          min_android_version: number;
          slots_needed?: number;
          status?: Database["public"]["Enums"]["request_status"];
          streak_days?: number;
          clock_started_at?: string | null;
          is_founding?: boolean;
          icon_url?: string | null;
          screenshots?: Json | null;
          created_at?: string;
          published_at?: string | null;
        };
        Update: {
          id?: string;
          owner_id?: string;
          app_name?: string;
          package_name?: string;
          description?: string;
          category?: Database["public"]["Enums"]["request_category"];
          join_method?: Database["public"]["Enums"]["join_method"];
          opt_in_url?: string;
          group_url?: string | null;
          instructions?: string;
          min_android_version?: number;
          slots_needed?: number;
          status?: Database["public"]["Enums"]["request_status"];
          streak_days?: number;
          clock_started_at?: string | null;
          is_founding?: boolean;
          icon_url?: string | null;
          screenshots?: Json | null;
          created_at?: string;
          published_at?: string | null;
        };
        Relationships: [];
      };
      engagements: {
        Row: {
          id: string;
          request_id: string;
          tester_id: string;
          device_id: string;
          status: Database["public"]["Enums"]["engagement_status"];
          joined_at: string;
          opted_in_at: string | null;
          confirmed_at: string | null;
          completed_at: string | null;
          last_checkin_at: string | null;
          checkin_count: number;
        };
        Insert: {
          id?: string;
          request_id: string;
          tester_id: string;
          device_id: string;
          status?: Database["public"]["Enums"]["engagement_status"];
          joined_at?: string;
          opted_in_at?: string | null;
          confirmed_at?: string | null;
          completed_at?: string | null;
          last_checkin_at?: string | null;
          checkin_count?: number;
        };
        Update: {
          id?: string;
          request_id?: string;
          tester_id?: string;
          device_id?: string;
          status?: Database["public"]["Enums"]["engagement_status"];
          joined_at?: string;
          opted_in_at?: string | null;
          confirmed_at?: string | null;
          completed_at?: string | null;
          last_checkin_at?: string | null;
          checkin_count?: number;
        };
        Relationships: [];
      };
      checkins: {
        Row: {
          id: string;
          engagement_id: string;
          status: Database["public"]["Enums"]["checkin_status"];
          note: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          engagement_id: string;
          status: Database["public"]["Enums"]["checkin_status"];
          note?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          engagement_id?: string;
          status?: Database["public"]["Enums"]["checkin_status"];
          note?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      feedback: {
        Row: {
          id: string;
          engagement_id: string;
          type: Database["public"]["Enums"]["feedback_type"];
          stability: number;
          ux: number;
          value: number;
          bugs: Json;
          suggestions: string | null;
          usage_frequency: Database["public"]["Enums"]["usage_frequency"];
          developer_rating: Database["public"]["Enums"]["developer_rating"] | null;
          addendum: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          engagement_id: string;
          type: Database["public"]["Enums"]["feedback_type"];
          stability: number;
          ux: number;
          value: number;
          bugs?: Json;
          suggestions?: string | null;
          usage_frequency: Database["public"]["Enums"]["usage_frequency"];
          developer_rating?: Database["public"]["Enums"]["developer_rating"] | null;
          addendum?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          engagement_id?: string;
          type?: Database["public"]["Enums"]["feedback_type"];
          stability?: number;
          ux?: number;
          value?: number;
          bugs?: Json;
          suggestions?: string | null;
          usage_frequency?: Database["public"]["Enums"]["usage_frequency"];
          developer_rating?: Database["public"]["Enums"]["developer_rating"] | null;
          addendum?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      credit_transactions: {
        Row: {
          id: string;
          user_id: string;
          amount: number;
          type: Database["public"]["Enums"]["transaction_type"];
          status: Database["public"]["Enums"]["transaction_status"];
          request_id: string | null;
          engagement_id: string | null;
          balance_after: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          amount: number;
          type: Database["public"]["Enums"]["transaction_type"];
          status: Database["public"]["Enums"]["transaction_status"];
          request_id?: string | null;
          engagement_id?: string | null;
          balance_after: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          amount?: number;
          type?: Database["public"]["Enums"]["transaction_type"];
          status?: Database["public"]["Enums"]["transaction_status"];
          request_id?: string | null;
          engagement_id?: string | null;
          balance_after?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      dossiers: {
        Row: {
          id: string;
          request_id: string;
          content_md: string;
          model_version: string;
          generated_at: string;
        };
        Insert: {
          id?: string;
          request_id: string;
          content_md: string;
          model_version: string;
          generated_at?: string;
        };
        Update: {
          id?: string;
          request_id?: string;
          content_md?: string;
          model_version?: string;
          generated_at?: string;
        };
        Relationships: [];
      };
      notifications: {
        Row: {
          id: string;
          user_id: string;
          type: string;
          payload: Json;
          emailed_at: string | null;
          read_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          type: string;
          payload?: Json;
          emailed_at?: string | null;
          read_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          type?: string;
          payload?: Json;
          emailed_at?: string | null;
          read_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      system_config: {
        Row: {
          key: string;
          value: Json;
        };
        Insert: {
          key: string;
          value: Json;
        };
        Update: {
          key?: string;
          value?: Json;
        };
        Relationships: [];
      };
    };
    Views: {
      public_profiles: {
        Row: {
          id: string;
          display_name: string;
          avatar_url: string | null;
          reliability_score: number;
          is_founding_member: boolean;
          created_at: string;
          completed_tests: number;
        };
        Relationships: [];
      };
      engagement_tester_contacts: {
        Row: {
          engagement_id: string;
          request_id: string;
          tester_id: string;
          testing_email: string;
        };
        Relationships: [];
      };
    };
    Functions: {
      is_admin: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      owns_request: {
        Args: { req: string };
        Returns: boolean;
      };
      is_engagement_party: {
        Args: { eng: string };
        Returns: boolean;
      };
    };
    Enums: {
      user_role: "user" | "admin";
      request_category:
        | "games"
        | "productivity"
        | "social"
        | "tools"
        | "lifestyle"
        | "education"
        | "finance"
        | "health"
        | "other";
      join_method: "email_list" | "google_group";
      request_status:
        | "draft"
        | "recruiting"
        | "active"
        | "at_risk"
        | "completed"
        | "cancelled"
        | "expired";
      engagement_status:
        | "pending_developer"
        | "confirmed"
        | "at_risk"
        | "completed"
        | "dropped"
        | "cancelled";
      checkin_status: "ok" | "issue";
      feedback_type: "mid" | "final";
      usage_frequency: "daily" | "few_weekly" | "rarely";
      developer_rating: "helpful" | "not_helpful";
      transaction_type:
        | "spend_post"
        | "escrow_hold"
        | "escrow_release"
        | "refund"
        | "bonus"
        | "admin_adjust";
      transaction_status: "pending" | "settled" | "cancelled";
    };
    CompositeTypes: Record<string, never>;
  };
};

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];
export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"];
export type Views<T extends keyof Database["public"]["Views"]> =
  Database["public"]["Views"][T]["Row"];
export type Enums<T extends keyof Database["public"]["Enums"]> =
  Database["public"]["Enums"][T];
