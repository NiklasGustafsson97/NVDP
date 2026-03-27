-- Migration: add intensity column to workouts table
-- Run this in Supabase SQL Editor (one-time)
alter table public.workouts add column if not exists intensity text;
