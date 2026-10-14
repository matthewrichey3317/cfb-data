import { Router, type IRouter } from "express";
import healthRouter from "./health";
import collectorRouter from "./collector";

const router: IRouter = Router();

router.use(healthRouter);
router.use(collectorRouter);

export default router;
