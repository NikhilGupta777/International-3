import { Router, type IRouter } from "express";
import healthRouter from "./health";
import opsRouter from "./ops";
import notificationsRouter from "./notifications";
import youtubeRouter from "./youtube";
import subtitlesRouter from "./subtitles";
import bhagwatRouter from "./bhagwat";
import timestampsRouter from "./timestamps";
import uploadsRouter from "./uploads";

const router: IRouter = Router();

router.use(healthRouter);
router.use(opsRouter);
router.use(notificationsRouter);
router.use(youtubeRouter);
router.use(subtitlesRouter);
router.use(bhagwatRouter);
router.use(timestampsRouter);
router.use("/uploads", uploadsRouter);

export default router;
