CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_vip BOOLEAN NOT NULL DEFAULT FALSE,
    vip_activated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT users_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
    CONSTRAINT users_email_length CHECK (char_length(email) BETWEEN 3 AND 254),
    CONSTRAINT users_email_normalized CHECK (email = lower(email)),
    CONSTRAINT users_password_hash_present CHECK (char_length(password_hash) > 0),
    CONSTRAINT users_vip_timestamp CHECK (is_vip OR vip_activated_at IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_created_at_idx ON users (created_at DESC);

CREATE TABLE IF NOT EXISTS parse_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_url TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    platform TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing',
    title TEXT,
    description TEXT,
    thumbnail_url TEXT,
    uploader TEXT,
    duration_seconds INTEGER,
    video_formats JSONB NOT NULL DEFAULT '[]'::JSONB,
    audio_formats JSONB NOT NULL DEFAULT '[]'::JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    error_code TEXT,
    error_message TEXT,
    error_action TEXT,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT parse_jobs_source_url_present CHECK (char_length(btrim(source_url)) > 0),
    CONSTRAINT parse_jobs_canonical_url_http CHECK (canonical_url ~* '^https?://'),
    CONSTRAINT parse_jobs_status_valid CHECK (status IN ('processing', 'succeeded', 'failed', 'rejected')),
    CONSTRAINT parse_jobs_duration_nonnegative CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
    CONSTRAINT parse_jobs_video_formats_array CHECK (jsonb_typeof(video_formats) = 'array'),
    CONSTRAINT parse_jobs_audio_formats_array CHECK (jsonb_typeof(audio_formats) = 'array'),
    CONSTRAINT parse_jobs_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
    CONSTRAINT parse_jobs_completion_consistent CHECK (
        (status = 'processing' AND completed_at IS NULL)
        OR (status IN ('succeeded', 'failed', 'rejected') AND completed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS parse_jobs_user_created_at_idx
    ON parse_jobs (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS parse_jobs_user_status_idx
    ON parse_jobs (user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS parse_jobs_status_updated_at_idx
    ON parse_jobs (status, updated_at ASC);
CREATE INDEX IF NOT EXISTS parse_jobs_platform_idx
    ON parse_jobs (platform);

CREATE TABLE IF NOT EXISTS usage_daily (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    usage_date DATE NOT NULL,
    accepted_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, usage_date),
    CONSTRAINT usage_daily_count_nonnegative CHECK (accepted_count >= 0)
);

CREATE INDEX IF NOT EXISTS usage_daily_date_idx ON usage_daily (usage_date DESC);
