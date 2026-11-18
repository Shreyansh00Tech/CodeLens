import { Router } from "express";
import * as userController from "../controllers/userController.js";
import { validate } from "../middleware/validate.js";
const router = Router();
router.get("/", userController.list);
router.post("/", validate("user"), userController.create);
router.route("/:id").get(userController.getById).delete(userController.remove);
export default router;
