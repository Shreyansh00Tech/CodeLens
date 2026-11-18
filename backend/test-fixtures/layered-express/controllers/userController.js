import userService from "../services/userService.js";
import { logEvent } from "../utils/logger.js";
export async function list(req, res) {
  const users = await userService.findAll(req.query);
  res.json(users);
}
export const create = async (req, res, next) => {
  try {
    const user = await userService.create(req.body);
    logEvent("user.created", user.id);
    res.status(201).json(user);
  } catch (err) { next(err); }
};
export async function getById(req, res) {
  const user = await userService.findById(req.params.id);
  if (!user) return res.status(404).json({ error: "Not found" });
  return res.json(user);
}
export function remove(req, res) { userService.remove(req.params.id).then(() => res.sendStatus(204)); }
