import User from "../models/User.js";
import axios from "axios";
class UserService {
  async findAll(q) { return User.find(q).lean(); }
  /** Load a single user by its id. */
  async findById(id) { return User.findById(id); }
  async create(data) {
    const u = await User.create(data);
    await this.notify(u);
    return u;
  }
  async notify(u) { await axios.post("https://hooks.example.com/new-user", u); }
  async remove(id) { return User.findByIdAndDelete(id); }
  unused() { return 1; }
}
export default new UserService();
