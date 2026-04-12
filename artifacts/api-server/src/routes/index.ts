import { Router, type IRouter } from "express";
import healthRouter from "./health";
import opsRouter from "./ops";
import notificationsRouter from "./notifications";
import youtubeRouter from "./youtube";
import subtitlesRouter from "./subtitles";

const router: IRouter = Router();

router.use(healthRouter);
router.use(opsRouter);
router.use(notificationsRouter);
router.use(youtubeRouter);
router.use(subtitlesRouter);

export default router;
