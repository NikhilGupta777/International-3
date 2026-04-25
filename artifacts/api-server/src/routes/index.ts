import { Router, type IRouter } from "express";
import healthRouter from "./health";
import opsRouter from "./ops";
import notificationsRouter from "./notifications";
import youtubeRouter from "./youtube";
import subtitlesRouter from "./subtitles";
import bhagwatRouter from "./bhagwat";
import timestampsRouter from "./timestamps";
import uploadsRouter from "./uploads";
import agentRouter from "./agent";

const router: IRouter = Router();

router.use(healthRouter);
router.use(opsRouter);
router.use(notificationsRouter);
router.use(youtubeRouter);
router.use(subtitlesRouter);
router.use(bhagwatRouter);
router.use(timestampsRouter);
router.use("/uploads", uploadsRouter);
router.use(agentRouter);

export default router;
