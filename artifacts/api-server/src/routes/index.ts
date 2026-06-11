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
import thumbnailRouter from "./thumbnail";
import translatorRouter from "./translator";
import adminRouter from "./admin";
import notebookRouter from "./notebook";
import pitajiRouter from "./pitaji";
import workspaceRouter from "./workspace";
import videoEditorRouter from "./video-editor";

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
router.use(thumbnailRouter);
router.use("/translator", translatorRouter);
router.use("/admin", adminRouter);
router.use(notebookRouter);
router.use(pitajiRouter);
router.use("/workspace", workspaceRouter);
router.use("/video-editor", videoEditorRouter);

export default router;
