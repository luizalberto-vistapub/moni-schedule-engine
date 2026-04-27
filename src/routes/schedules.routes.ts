import { Router } from "express";
import { generateSchedule, recalculateSchedule } from "../controllers/schedules.controller.js";

export const schedulesRoutes = Router();

schedulesRoutes.post("/generate", generateSchedule);
schedulesRoutes.post("/recalculate", recalculateSchedule);