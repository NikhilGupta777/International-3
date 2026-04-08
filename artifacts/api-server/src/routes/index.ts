import { Router, type IRouter } from "express";
import healthRouter from "./health";
import youtubeRouter from "./youtube";
import bhagwatRouter from "./bhagwat";
import subtitlesRouter from "./subtitles";

const router: IRouter = Router();

router.use(healthRouter);
router.use(youtubeRouter);
router.use(bhagwatRouter);
router.use(subtitlesRouter);

export default router;
